import * as url from 'url';
import FORMATS from './formats';

// const url      = require('url');
// const FORMATS  = require('./formats');


// Use these to help sort formats, higher is better.
const audioEncodingRanks = [
  'mp4a',
  'mp3',
  'vorbis',
  'aac',
  'opus',
  'flac',
] as const;
const videoEncodingRanks = [
  'mp4v',
  'avc1',
  'Sorenson H.283',
  'MPEG-4 Visual',
  'VP8',
  'VP9',
  'H.264',
] as const;

const getBitrate = (format) => parseInt(format.bitrate) || 0;
const audioScore = (format) => {
  const abitrate = format.audioBitrate || 0;
  const aenc = audioEncodingRanks.findIndex(enc => format.codecs && format.codecs.includes(enc));
  return abitrate + aenc / 10;
};


/**
 * Sort formats from highest quality to lowest.
 * By resolution, then video bitrate, then audio bitrate.
 *
 * @param {Object} a
 * @param {Object} b
 */
export const sortFormats = (a, b) => {
  const ares = a.qualityLabel ? parseInt(a.qualityLabel.slice(0, -1)) : 0;
  const bres = b.qualityLabel ? parseInt(b.qualityLabel.slice(0, -1)) : 0;
  const afeats = ~~!!ares * 2 + ~~!!a.audioBitrate;
  const bfeats = ~~!!bres * 2 + ~~!!b.audioBitrate;

  if (afeats === bfeats) {
    if (ares === bres) {
      let avbitrate = getBitrate(a);
      let bvbitrate = getBitrate(b);
      if (avbitrate === bvbitrate) {
        let aascore = audioScore(a);
        let bascore = audioScore(b);
        if (aascore === bascore) {
          const avenc = videoEncodingRanks.findIndex(enc => a.codecs && a.codecs.includes(enc));
          const bvenc = videoEncodingRanks.findIndex(enc => b.codecs && b.codecs.includes(enc));
          return bvenc - avenc;
        } else {
          return bascore - aascore;
        }
      } else {
        return bvbitrate - avbitrate;
      }
    } else {
      return bres - ares;
    }
  } else {
    return bfeats - afeats;
  }
};


/**
 * Choose a format depending on the given options.
 *
 * @param {Array.<Object>} formats
 * @param {Object} options
 * @return {Object|Error}
 */
export const chooseFormat = (formats, options) => {
  if (typeof options.format === 'object') {
    return options.format;
  }

  if (options.filter) {
    formats = filterFormats(formats, options.filter);
    if (formats.length === 0) {
      return Error('No formats found with custom filter');
    }
  }

  let format;
  const quality = options.quality || 'highest';
  switch (quality) {
    case 'highest':
      format = formats[0];
      break;

    case 'lowest':
      format = formats[formats.length - 1];
      break;

    case 'highestaudio':
      formats = filterFormats(formats, 'audio');
      format = null;
      for (let f of formats) {
        if (!format
          || audioScore(f) > audioScore(format))
          format = f;
      }
      break;

    case 'lowestaudio':
      formats = filterFormats(formats, 'audio');
      format = null;
      for (let f of formats) {
        if (!format
          || audioScore(f) < audioScore(format))
          format = f;
      }
      break;

    case 'highestvideo':
      formats = filterFormats(formats, 'video');
      format = null;
      for (let f of formats) {
        if (!format
          || getBitrate(f) > getBitrate(format))
          format = f;
      }
      break;

    case 'lowestvideo':
      formats = filterFormats(formats, 'video');
      format = null;
      for (let f of formats) {
        if (!format
          || getBitrate(f) < getBitrate(format))
          format = f;
      }
      break;

    default: {
      let getFormat = (itag) => {
        return formats.find((format) => '' + format.itag === '' + itag);
      };
      if (Array.isArray(quality)) {
        quality.find((q) => format = getFormat(q));
      } else {
        format = getFormat(quality);
      }
    }

  }

  if (!format) {
    return Error('No such format found: ' + quality);
  }
  return format;
};


/**
 * @param {Array.<Object>} formats
 * @param {Function} filter
 * @return {Array.<Object>}
 */
export const filterFormats = (formats, filter) => {
  let fn;
  const hasVideo = format => !!format.qualityLabel;
  const hasAudio = format => !!format.audioBitrate;
  switch (filter) {
    case 'audioandvideo':
      fn = (format) => hasVideo(format) && hasAudio(format);
      break;

    case 'video':
      fn = hasVideo;
      break;

    case 'videoonly':
      fn = (format) => hasVideo(format) && !hasAudio(format);
      break;

    case 'audio':
      fn = hasAudio;
      break;

    case 'audioonly':
      fn = (format) => !hasVideo(format) && hasAudio(format);
      break;

    default:
      if (typeof filter === 'function') {
        fn = filter;
      } else {
        throw TypeError(`Given filter (${filter}) is not supported`);
      }
  }
  return formats.filter(fn);
};


/**
 * String#indexOf() that supports regex too.
 */
const indexOf = (haystack: string, needle: string | RegExp): number => {
  return needle instanceof RegExp ?
    haystack.search(needle) : haystack.indexOf(needle);
};


/**
 * Extract string inbetween another.
 */
export const between = (haystack: string, left: string, right: string | RegExp) => {
  let pos = indexOf(haystack, left);
  if (pos === -1) { return ''; }
  haystack = haystack.slice(pos + left.length);
  pos = indexOf(haystack, right);
  if (pos === -1) { return ''; }
  haystack = haystack.slice(0, pos);
  return haystack;
};


/**
 * Get video ID.
 *
 * There are a few type of video URL formats.
 *  - https://www.youtube.com/watch?v=VIDEO_ID
 *  - https://m.youtube.com/watch?v=VIDEO_ID
 *  - https://youtu.be/VIDEO_ID
 *  - https://www.youtube.com/v/VIDEO_ID
 *  - https://www.youtube.com/embed/VIDEO_ID
 *  - https://music.youtube.com/watch?v=VIDEO_ID
 *  - https://gaming.youtube.com/watch?v=VIDEO_ID
 *
 * @param {string} link
 * @return {string|Error}
 */
const validQueryDomains = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
]);
const validPathDomains = /^https?:\/\/(youtu\.be\/|(www\.)?youtube.com\/(embed|v)\/)/;
export const getURLVideoID = (link: string) => {
  const parsed = url.parse(link, true);
  let id = parsed.query.v;
  if (validPathDomains.test(link) && !id) {
    const paths = parsed.pathname.split('/');
    id = paths[paths.length - 1];
  } else if (parsed.hostname && !validQueryDomains.has(parsed.hostname)) {
    return Error('Not a YouTube domain');
  }
  if (!id) {
    return Error('No video id found: ' + link);
  }
  id = (id as string).substring(0, 11);
  if (!validateID(id)) {
    return TypeError(`Video id (${id}) does not match expected ` +
      `format (${idRegex.toString()})`);
  }
  return id;
};


/**
 * Gets video ID either from a url or by checking if the given string
 * matches the video ID format.
 *
 * @param {string} str
 * @return {string|Error}
 */
export const getVideoID = (str: string) => {
  if (validateID(str)) {
    return str;
  } else {
    return getURLVideoID(str);
  }
};


/**
 * Returns true if given id satifies YouTube's id format.
 *
 * @param {string} id
 * @return {boolean}
 */
const idRegex = /^[a-zA-Z0-9-_]{11}$/;
export const validateID = (id: string) => {
  return idRegex.test(id);
};


/**
 * Checks wether the input string includes a valid id.
 *
 * @param {string} string
 * @return {boolean}
 */
export const validateURL = (string: string) => {
  return !(getURLVideoID(string) instanceof Error);
};


/**
 * @param {Object} format
 * @return {Object}
 */
export const addFormatMeta = (format) => {
  format = Object.assign({}, FORMATS[format.itag], format);
  format.container = format.mimeType ?
    format.mimeType.split(';')[0].split('/')[1] : null;
  format.codecs = format.mimeType ?
    between(format.mimeType, 'codecs="', '"') : null;
  format.live = /\/source\/yt_live_broadcast\//.test(format.url);
  format.isHLS = /\/manifest\/hls_(variant|playlist)\//.test(format.url);
  format.isDashMPD = /\/manifest\/dash\//.test(format.url);
  return format;
};


/**
 * Get only the string from an HTML string.
 *
 * @param {string} html
 * @return {string}
 */
export const stripHTML = (html: string) => {
  return html
    .replace(/[\n\r]/g, ' ')
    .replace(/\s*<\s*br\s*\/?\s*>\s*/gi, '\n')
    .replace(/<\s*\/\s*p\s*>\s*<\s*p[^>]*>/gi, '\n')
    .replace(/<.*?>/gi, '')
    .trim();
};
