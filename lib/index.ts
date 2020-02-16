import { PassThrough, Readable } from 'stream';
import * as info from './info';
import * as util from './util';
import * as sig from './sig';
import axios, { AxiosResponse } from 'axios';

import m3u8stream from 'm3u8stream';
import parseTime from 'm3u8stream/dist/parse-time';
import { DownloadOptions, VideoInfo, VideoFormat } from './models';
import request from './client';

declare module 'stream' {
  interface PassThrough {
    _isDestroyed?: boolean;
  }

  interface Readable {
    _isDestroyed?: boolean;
  }
}

interface YtdlStreamEventObj {
  error: Error;
  close: void;
  abort: void;
  response: AxiosResponse | null;
  progress: { chunkLength: number; downloaded: number; total: number };
  info: { info: VideoInfo; format: VideoFormat };
}

interface YtdlStream extends Readable {
  on<K extends keyof YtdlStreamEventObj>(eventName: K, handler: (e: YtdlStreamEventObj[K], ...args: any[]) => void): this;
  once<K extends keyof YtdlStreamEventObj>(eventName: K, handler: (e: YtdlStreamEventObj[K], ...args: any[]) => void): this;
}

const ytdl = (link: string, options?: DownloadOptions): YtdlStream => {
  const stream = createStream(options);

  getInfo(link, options)
    .then((info) => {
      stream.emit('info', info);

      return downloadFromInfoCallback(stream, info, options);
    })
    .catch((e) => stream.emit('error', e));

  return stream;
};

const createStream = (options: DownloadOptions) => {
  const stream = new PassThrough({
    highWaterMark: options?.highWaterMark ?? null,
  });
  stream.destroy = () => {
    stream._isDestroyed = true;
  };

  return stream;
};

/**
 * Chooses a format to download.
 *
 * @param {stream.Readable} stream
 * @param {Object} info
 * @param {Object} options
 */
const downloadFromInfoCallback = async (stream: Readable, info: VideoInfo, options: DownloadOptions) => {
  options = options || {};

  const format = util.chooseFormat(info.formats, options);
  if (format instanceof Error) {
    // The caller expects this function to be async.
    setImmediate(() => {
      stream.emit('error', format);
    });
    return;
  }
  stream.emit('info', { info, format });
  if (stream._isDestroyed) { return; }

  let contentLength = 0;
  let downloaded = 0;
  const ondata = (chunk: Buffer) => {
    downloaded += chunk.length;

    stream.emit('progress', {
      chunkLength: chunk.length,
      downloaded,
      total: contentLength,
    });
  };

  let reqType: 'axios' | 'miniget';
  let req;
  if (format.isHLS || format.isDashMPD) {
    reqType = 'miniget';
    req = m3u8stream(format.url, {
      chunkReadahead: +info.live_chunk_readahead,
      begin: (options.begin || format.live && Date.now()) as any,
      liveBuffer: options.liveBuffer,
      requestOptions: (options.requestOptions) as any,
      parser: format.isDashMPD ? 'dash-mpd' : 'm3u8',
      id: format.itag,
    });

    req.on('progress', (segment, totalSegments) => {
      stream.emit('progress', {
        chunkLength: segment.size,
        downloaded: segment.num,
        total: totalSegments,
      });
    });

  } else {
    if (options.begin) {
      format.url += '&begin=' + parseTime.humanStr(options.begin as any);
    }
    let requestOptions = Object.assign({}, options.requestOptions);
    if (options.range && (options.range.start || options.range.end)) {
      requestOptions.headers = Object.assign({}, requestOptions.headers, {
        Range: `bytes=${options.range.start || '0'}-${options.range.end || ''}`,
      });
    }

    reqType = 'axios';
    const source = axios.CancelToken.source();
    req = await request.get(format.url, {
      ...requestOptions,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.106 Safari/537.36',
        Referer: `https://www.youtube.com/watch/${info.video_id}`,

        ...requestOptions.headers,
      },
      responseType: 'stream',
      cancelToken: source.token,
    });
    stream.emit('response', req);
    req.abort = () => source.cancel();

    if (stream._isDestroyed) {
      return;
    }

    if (!contentLength) {
      contentLength = Number(req.headers['content-length']);
    }
    req.data.on('data', ondata);
  }

  stream.destroy = () => {
    stream._isDestroyed = true;
    if (req.abort) req.abort();
    req.end?.();
    req.removeListener?.('data', ondata);
    if (reqType === 'miniget') {
      req.unpipe?.();
    } else {
      req.data.unpipe?.();
    }
  };

  if (reqType === 'miniget') {
    // Forward events from the request to the stream.
    [
      'abort', 'request', 'response', 'error', 'retry', 'reconnect',
    ].forEach((event) => {
      req.prependListener?.(event, (arg) => {
        stream.emit(event, arg);
      });
    });

    req.pipe(stream);
  } else {
    req.data.pipe(stream);
  }
};

export const downloadFromInfo = (info: VideoInfo, options: DownloadOptions) => {
  const stream = createStream(options);
  if (!info.full) {
    throw new Error('Cannot use `ytdl.downloadFromInfo()` when called ' +
      'with info from `ytdl.getBasicInfo()`');
  }

  downloadFromInfoCallback(stream, info, options);
  return stream;
};

export default ytdl;
export const getBasicInfo = info.getBasicInfo;
export const getInfo = info.getFullInfo;
export const chooseFormat = util.chooseFormat;
export const filterFormats = util.filterFormats;
export const validateID = util.validateID;
export const validateURL = util.validateURL;
export const getURLVideoID = util.getURLVideoID;
export const getVideoID = util.getVideoID;
export const cache = Object.freeze({
  sig: sig.cache,
  info: info.cache,
});

export {
  ytdl,
};
