import { applyCache } from './cache';
import * as urllib from 'url';
import * as qs from 'qs';
import sax from 'sax';
import axios from 'axios';
import * as util from './util';
import * as extras from './info-extras';
import * as sig from './sig';
import { DownloadOptions, VideoInfo } from './models';
import LRU from 'lru-cache';
import request from './client';

const VIDEO_URL = 'https://www.youtube.com/watch?v=';
const EMBED_URL = 'https://www.youtube.com/embed/';
const VIDEO_EURL = 'https://youtube.googleapis.com/v/';
const INFO_HOST = 'www.youtube.com';
const INFO_PATH = '/get_video_info';

/**
 * Gets info from a video without getting additional formats.
 */
export const _getBasicInfo = async (id: string, options: DownloadOptions = {}): Promise<VideoInfo> => {
  // Try getting config from the video page first.
  const params = 'hl=' + (options.lang ?? 'en');
  let url = VIDEO_URL + id + '&' + params +
    '&bpctr=' + Math.ceil(Date.now() / 1000);

  // Remove header from watch page request.
  // Otherwise, it'll use a different framework for rendering content.
  const reqOptions = Object.assign({}, options.requestOptions ?? {});
  reqOptions.headers = Object.assign({}, reqOptions.headers, {
    'User-Agent': '',
  });

  const resp = await request.get(url, reqOptions);
  const body = resp.data;

  // Check if there are any errors with this video page.
  const unavailableMsg = util.between(body, '<div id="player-unavailable"', '>');
  if (unavailableMsg &&
    !/\bhid\b/.test(util.between(unavailableMsg, 'class="', '"'))) {
    // Ignore error about age restriction.
    if (!body.includes('<div id="watch7-player-age-gate-content"')) {
      throw new Error(util.between(body, '<h1 id="unavailable-message" class="message">', '</h1>').trim());
    }
  }

  // Parse out additional metadata from this page.
  const additional = {
    // Get the author/uploader.
    author: extras.getAuthor(body),

    // Get the day the vid was published.
    published: extras.getPublished(body),

    // Get description.
    description: extras.getVideoDescription(body),

    // Get media info.
    media: extras.getVideoMedia(body),

    // Get related videos.
    related_videos: extras.getRelatedVideos(body),

    // Get likes.
    likes: extras.getLikes(body),

    // Get dislikes.
    dislikes: extras.getDislikes(body),
  };

  const jsonStr = util.between(body, 'ytplayer.config = ', '</script>');
  let config;
  if (jsonStr) {
    config = jsonStr.slice(0, jsonStr.lastIndexOf(';ytplayer.load'));
    return gotConfig(id, options, additional, config, false);
  }

  // If the video page doesn't work, maybe because it has mature content.
  // and requires an account logged in to view, try the embed page.
  url = EMBED_URL + id + '?' + params;
  const resp2 = await request.get(url, options.requestOptions);
  config = util.between(resp2.data, 't.setConfig({\'PLAYER_CONFIG\': ', /\}(,'|\}\);)/);
  return gotConfig(id, options, additional, config, true);
};

const parseFormats = (info: VideoInfo) => {
  let formats = [] as any[];
  if (info.player_response.streamingData) {
    if (info.player_response.streamingData.formats) {
      formats = formats.concat(info.player_response.streamingData.formats);
    }
    if (info.player_response.streamingData.adaptiveFormats) {
      formats = formats.concat(info.player_response.streamingData.adaptiveFormats);
    }
  }
  return formats;
};

const gotConfig = async (id: string, options: DownloadOptions, additional: any, config: any, fromEmbed: boolean): Promise<VideoInfo> => {
  if (!config) {
    throw new Error('Could not find player config');
  }

  try {
    config = JSON.parse(config + (fromEmbed ? '}' : ''));
  } catch (err) {
    throw new Error('Error parsing config: ' + err.message);
  }

  const url = urllib.format({
    protocol: 'https',
    host: INFO_HOST,
    pathname: INFO_PATH,
    query: {
      video_id: id,
      eurl: VIDEO_EURL + id,
      ps: 'default',
      gl: 'US',
      hl: (options.lang || 'en'),
      sts: config.sts,
    },
  });
  const resp = await request.get(url, options.requestOptions);
  const body = resp.data;

  const info = qs.parse(body);
  const player_response = config.args.player_response || info.player_response;

  if (info.status === 'fail') {
    throw new Error(`Code ${info.errorcode}: ${util.stripHTML(info.reason)}`);
  } else {
    try {
      info.player_response = JSON.parse(player_response);
    } catch (err) {
      throw new Error('Error parsing `player_response`: ' + err.message);
    }
  }

  const playability = info.player_response.playabilityStatus;
  if (playability && playability.status === 'UNPLAYABLE') {
    throw new Error(util.stripHTML(playability.reason));
  }

  return {
    ...info,
    ...additional,

    formats: parseFormats(info),
    video_id: id,
    // Give the standard link to the video.
    video_url: VIDEO_URL + id,

    // Copy over a few props from `player_response.videoDetails`
    // for backwards compatibility.
    title: info.player_response.videoDetails && info.player_response.videoDetails.title,
    length_seconds: info.player_response.videoDetails && info.player_response.videoDetails.lengthSeconds,

    age_restricted: fromEmbed,
    html5player: config.assets?.js,
  };
};


/**
 * Gets info from a video additional formats and deciphered URLs.
 */
export const _getFullInfo = async (id: string, options: DownloadOptions = {}) => {
  const info = await getBasicInfo(id, options);
  const hasManifest =
    info.player_response && info.player_response.streamingData && (
      !!info.player_response.streamingData.dashManifestUrl ||
      !!info.player_response.streamingData.hlsManifestUrl
    );

  if (info.formats.length || hasManifest) {
    const html5playerfile = urllib.resolve(VIDEO_URL, info.html5player);
    const tokens = await sig.getTokens(html5playerfile, options);

    sig.decipherFormats(info.formats, tokens, options.debug);

    const promises = [] as Promise<any>[];
    if (hasManifest && info.player_response.streamingData.dashManifestUrl) {
      let url = info.player_response.streamingData.dashManifestUrl;
      promises.push(getDashManifest(url, options));
    }
    if (hasManifest && info.player_response.streamingData.hlsManifestUrl) {
      let url = info.player_response.streamingData.hlsManifestUrl;
      promises.push(getM3U8(url, options));
    }

    const results = await Promise.all(promises);
    if (results[0]) {
      mergeFormats(info, results[0]);
    }
    if (results[1]) {
      mergeFormats(info, results[1]);
    }

    info.formats = info.formats.map(util.addFormatMeta).sort(util.sortFormats);
    info.full = true;

    return info;
  }

  throw new Error('This video is unavailable');
};


/**
 * Merges formats from DASH or M3U8 with formats from video info page.
 *
 * @param {Object} info
 * @param {Object} formatsMap
 */
const mergeFormats = (info, formatsMap) => {
  info.formats.forEach((f) => {
    formatsMap[f.itag] = formatsMap[f.itag] || f;
  });
  info.formats = Object.values(formatsMap);
};


/**
 * Gets additional DASH formats.
 *
 * @param {string} url
 * @param {Object} options
 * @param {Function(!Error, Array.<Object>)} callback
 */
const getDashManifest = async (url: string, options: DownloadOptions) => {
  let formats = {} as { [key: string]: any };

  const parser = sax.parser(false);

  return new Promise<any>((resolve, reject) => {
    parser.onerror = reject;

    parser.onopentag = (node) => {
      if (node.name === 'REPRESENTATION') {
        const itag = node.attributes.ID as any;
        formats[itag] = { itag, url };
      }
    };
    parser.onend = () => resolve(formats);

    request.get(urllib.resolve(VIDEO_URL, url), options.requestOptions)
      .then((resp) => {
        parser.write(resp.data);
        parser.close();
      })
      .catch(reject);
  });
};


/**
 * Gets additional formats.
 *
 * @param {string} url
 * @param {Object} options
 * @param {Function(!Error, Array.<Object>)} callback
 */
const getM3U8 = async (url: string, options: DownloadOptions) => {
  url = urllib.resolve(VIDEO_URL, url);

  const resp = await request.get<string>(url, options.requestOptions);
  const body = resp.data;

  return body
    .split('\n')
    .filter((line) => /https?:\/\//.test(line))
    .reduce((formats, line) => {
      const itag = line.match(/\/itag\/(\d+)\//)[1];
      formats[itag] = { itag, url: line };

      return formats;
    }, {} as any);
};


// Cached for getting basic/full info.
export const cache = new LRU({
  max: 10,
  maxAge: 600,
});


// Cache get info functions.
// In case a user wants to get a video's info before downloading.
const generateKeyFn = (fnName: string) => ([id, options]: Parameters<typeof _getBasicInfo>) => {
  return `${fnName}-${id}-${options?.lang ?? 'en'}`;
};
const remapArgs = ([link, options]: Parameters<typeof _getBasicInfo>) => {
  const id = util.getVideoID(link);

  return [id, options ?? {}];
};
export const getBasicInfo = applyCache(cache, _getBasicInfo, generateKeyFn('getBasicInfo'), remapArgs);
export const getFullInfo = applyCache(cache, _getFullInfo, generateKeyFn('getFullInfo'), remapArgs);


// Export a few helpers.
export const validateID = util.validateID;
export const validateURL = util.validateURL;
export const getURLVideoID = util.getURLVideoID;
export const getVideoID = util.getVideoID;
