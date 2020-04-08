/*
 * Websock: high-performance binary WebSockets
 * Copyright (C) 2019 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Websock is similar to the standard WebSocket object but with extra
 * buffer handling.
 *
 * Websock has built-in receive queue buffering; the message event
 * does not contain actual data but is simply a notification that
 * there is new data available. Several rQ* methods are available to
 * read binary data off of the receive queue.
 */

import * as Log from './util/logging.js';
import * as proto from '../message.js';
import { ZstdCodec } from 'zstd-codec';
let simple_zstd;
ZstdCodec.run((zstd) => {
    simple_zstd = new zstd.Simple();
});

export default class Websock {
    constructor() {
        this._websocket = null;  // WebSocket object
        this._eventHandlers = {
            message: (msg) => {},
            open: () => {},
            close: () => {},
            error: () => {}
        };
        this._next_yuv = null;
        this._next_rgb = null;
    }

    send(msg) {
        if (msg instanceof Object) msg = proto.encodeMessage(msg);
        this._websocket.send(msg);
    }

    // Event Handlers
    off(evt) {
        this._eventHandlers[evt] = () => {};
    }

    on(evt, handler) {
        this._eventHandlers[evt] = handler;
    }

    init() {
        this._websocket = null;
    }

    open(uri, protocols) {
        this.init();

        this._websocket = new WebSocket(uri, protocols);

        this._websocket.onmessage = this._recv_message.bind(this);
        this._websocket.binaryType = 'arraybuffer';
        this._websocket.onopen = () => {
            Log.Debug('>> WebSock.onopen');
            if (this._websocket.protocol) {
                Log.Info("Server choose sub-protocol: " + this._websocket.protocol);
            }

            this._eventHandlers.open();
            Log.Debug("<< WebSock.onopen");
        };
        this._websocket.onclose = (e) => {
            Log.Debug(">> WebSock.onclose");
            this._eventHandlers.close(e);
            Log.Debug("<< WebSock.onclose");
        };
        this._websocket.onerror = (e) => {
            Log.Debug(">> WebSock.onerror: " + e);
            this._eventHandlers.error(e);
            Log.Debug("<< WebSock.onerror: " + e);
        };
    }

    close() {
        if (this._websocket) {
            if ((this._websocket.readyState === WebSocket.OPEN) ||
                    (this._websocket.readyState === WebSocket.CONNECTING)) {
                Log.Info("Closing WebSocket connection");
                this._websocket.close();
            }

            this._websocket.onmessage = () => {};
        }
    }

    _recv_message(e) {
        if (e.data instanceof window.ArrayBuffer) {
            let bytes = new Uint8Array(e.data);
            if (this._next_yuv) {
                const yuv = this._next_yuv;
                const { compress, stride } = yuv.format;
                if (compress) {
                    bytes = simple_zstd.decompress(bytes);
                }
                if (!yuv.y) {
                    yuv.y = { bytes, stride: stride };
                } else if (!yuv.u) {
                    yuv.u = { bytes, stride: stride >> 1 };
                } else {
                    yuv.v = { bytes, stride: stride >> 1 };
                    delete yuv.format.stride;
                    this._eventHandlers.message({ video_frame: { yuv } });
                    this._next_yuv = null;
                }
            } else if (this._next_rgb) {
                if (this._next_rgb.format.compress) {
                    bytes = simple_zstd.decompress(bytes);
                }
                this._eventHandlers.message({ video_frame: { rgb: bytes }});
                this._next_rgb = null;
            } else {
                const msg = proto.decodeMessage(bytes);
                let vf = msg.video_frame;
                if (vf) {
                    const { yuv, rgb } = vf;
                    if (yuv) {
                        this._next_yuv = { format: yuv };
                    } else if (rgb) {
                        this._next_rgb = { format: rgb };
                    }
                    return;
                } else {
                    this._eventHandlers.message(msg);
                }
            }
        }
    }
}
