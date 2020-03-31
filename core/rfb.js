/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2020 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */

import { toUnsigned32bit, toSigned32bit } from './util/int.js';
import * as Log from './util/logging.js';
import { encodeUTF8, decodeUTF8 } from './util/strings.js';
import { dragThreshold } from './util/browser.js';
import EventTargetMixin from './util/eventtarget.js';
import Display from "./display.js";
import Inflator from "./inflator.js";
import Deflator from "./deflator.js";
import Keyboard from "./input/keyboard.js";
import Mouse from "./input/mouse.js";
import Cursor from "./util/cursor.js";
import Websock from "./websock.js";
import DES from "./des.js";
import KeyTable from "./input/keysym.js";
import XtScancode from "./input/xtscancodes.js";
import { encodings } from "./encodings.js";
import "./util/polyfill.js";

import RawDecoder from "./decoders/raw.js";
import CopyRectDecoder from "./decoders/copyrect.js";
import RREDecoder from "./decoders/rre.js";
import HextileDecoder from "./decoders/hextile.js";
import TightDecoder from "./decoders/tight.js";
import TightPNGDecoder from "./decoders/tightpng.js";

// How many seconds to wait for a disconnect to finish
const DISCONNECT_TIMEOUT = 3;
const DEFAULT_BACKGROUND = 'rgb(40, 40, 40)';

// Extended clipboard pseudo-encoding formats
const extendedClipboardFormatText   = 1;
/*eslint-disable no-unused-vars */
const extendedClipboardFormatRtf    = 1 << 1;
const extendedClipboardFormatHtml   = 1 << 2;
const extendedClipboardFormatDib    = 1 << 3;
const extendedClipboardFormatFiles  = 1 << 4;
/*eslint-enable */

// Extended clipboard pseudo-encoding actions
const extendedClipboardActionCaps    = 1 << 24;
const extendedClipboardActionRequest = 1 << 25;
const extendedClipboardActionPeek    = 1 << 26;
const extendedClipboardActionNotify  = 1 << 27;
const extendedClipboardActionProvide = 1 << 28;


export default class RFB extends EventTargetMixin {
    constructor(target, url, options) {
        if (!target) {
            throw new Error("Must specify target");
        }
        if (!url) {
            throw new Error("Must specify URL");
        }

        super();

        this._target = target;
        this._url = url;

        // Connection details
        options = options || {};
        this._rfb_credentials = options.credentials || {};
        this._challenge = '';
        this._server_info = {};
        this._shared = 'shared' in options ? !!options.shared : true;
        this._repeaterID = options.repeaterID || '';
        this._wsProtocols = options.wsProtocols || [];

        // Internal state
        this._rfb_connection_state = '';
        this._rfb_clean_disconnect = true;

        this._fb_width = 0;
        this._fb_height = 0;

        this._fb_name = "";

        this._capabilities = { power: false };

        this._supportsSetDesktopSize = false;
        this._screen_id = 0;
        this._screen_flags = 0;

        this._qemuExtKeyEventSupported = false;

        this._clipboardText = null;
        this._clipboardServerCapabilitiesActions = {};
        this._clipboardServerCapabilitiesFormats = {};

        // Internal objects
        this._sock = null;              // Websock object
        this._display = null;           // Display object
        this._flushing = false;         // Display flushing state
        this._keyboard = null;          // Keyboard input handler object
        this._mouse = null;             // Mouse input handler object

        // Timers
        this._disconnTimer = null;      // disconnection timer
        this._resizeTimeout = null;     // resize rate limiting

        // Decoder states
        this._decoders = {};

        this._FBU = {
            rects: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            encoding: null,
        };

        // Mouse state
        this._mouse_buttonMask = 0;
        this._mouse_arr = [];
        this._viewportDragging = false;
        this._viewportDragPos = {};
        this._viewportHasMoved = false;

        // Bound event handlers
        this._eventHandlers = {
            focusCanvas: this._focusCanvas.bind(this),
            windowResize: this._windowResize.bind(this),
        };

        // main setup
        Log.Debug(">> RFB.constructor");

        // Create DOM elements
        this._screen = document.createElement('div');
        this._screen.style.display = 'flex';
        this._screen.style.width = '100%';
        this._screen.style.height = '100%';
        this._screen.style.overflow = 'auto';
        this._screen.style.background = DEFAULT_BACKGROUND;
        this._canvas = document.createElement('canvas');
        this._canvas.style.margin = 'auto';
        // Some browsers add an outline on focus
        this._canvas.style.outline = 'none';
        // IE miscalculates width without this :(
        this._canvas.style.flexShrink = '0';
        this._canvas.width = 0;
        this._canvas.height = 0;
        this._canvas.tabIndex = -1;
        this._screen.appendChild(this._canvas);

        // Cursor
        this._cursor = new Cursor();

        // XXX: TightVNC 2.8.11 sends no cursor at all until Windows changes
        // it. Result: no cursor at all until a window border or an edit field
        // is hit blindly. But there are also VNC servers that draw the cursor
        // in the framebuffer and don't send the empty local cursor. There is
        // no way to satisfy both sides.
        //
        // The spec is unclear on this "initial cursor" issue. Many other
        // viewers (TigerVNC, RealVNC, Remmina) display an arrow as the
        // initial cursor instead.
        this._cursorImage = RFB.cursors.none;

        // populate decoder array with objects
        this._decoders[encodings.encodingRaw] = new RawDecoder();
        this._decoders[encodings.encodingCopyRect] = new CopyRectDecoder();
        this._decoders[encodings.encodingRRE] = new RREDecoder();
        this._decoders[encodings.encodingHextile] = new HextileDecoder();
        this._decoders[encodings.encodingTight] = new TightDecoder();
        this._decoders[encodings.encodingTightPNG] = new TightPNGDecoder();

        // NB: nothing that needs explicit teardown should be done
        // before this point, since this can throw an exception
        try {
            this._display = new Display(this._canvas);
        } catch (exc) {
            Log.Error("Display exception: " + exc);
            throw exc;
        }
        this._display.onflush = this._onFlush.bind(this);

        this._keyboard = new Keyboard(this._canvas);
        this._keyboard.onkeyevent = this._handleKeyEvent.bind(this);

        this._mouse = new Mouse(this._canvas);
        this._mouse.onmousebutton = this._handleMouseButton.bind(this);
        this._mouse.onmousemove = this._handleMouseMove.bind(this);

        this._sock = new Websock();
        this._sock.on('message', (msg) => {
            this._handle_message(msg);
        });
        this._sock.on('open', () => {
            if (this._rfb_connection_state === 'connecting') {
                Log.Debug("Starting VNC handshake");
                let tmp = window.location.href.split('?');
                if (tmp.length) {
                    let id = tmp[tmp.length - 1];
                    Log.Debug('Joining ' + id);
                    this._sock.send(id);
                }
            } else {
                this._fail("Unexpected server connection while " +
                           this._rfb_connection_state);
            }
        });
        this._sock.on('close', (e) => {
            Log.Debug("WebSocket on-close event");
            let msg = "";
            if (e.code) {
                msg = "(code: " + e.code;
                if (e.reason) {
                    msg += ", reason: " + e.reason;
                }
                msg += ")";
            }
            switch (this._rfb_connection_state) {
                case 'connecting':
                    this._fail("Connection closed " + msg);
                    break;
                case 'connected':
                    // Handle disconnects that were initiated server-side
                    this._updateConnectionState('disconnecting');
                    this._updateConnectionState('disconnected');
                    break;
                case 'disconnecting':
                    // Normal disconnection path
                    this._updateConnectionState('disconnected');
                    break;
                case 'disconnected':
                    this._fail("Unexpected server disconnect " +
                               "when already disconnected " + msg);
                    break;
                default:
                    this._fail("Unexpected server disconnect before connecting " +
                               msg);
                    break;
            }
            this._sock.off('close');
        });
        this._sock.on('error', e => Log.Warn("WebSocket on-error event"));

        // Slight delay of the actual connection so that the caller has
        // time to set up callbacks
        setTimeout(this._updateConnectionState.bind(this, 'connecting'));

        Log.Debug("<< RFB.constructor");

        // ===== PROPERTIES =====

        this.dragViewport = false;
        this.focusOnClick = true;

        this._viewOnly = false;
        this._clipViewport = false;
        this._scaleViewport = false;
        this._resizeSession = false;

        this._showDotCursor = false;
        if (options.showDotCursor !== undefined) {
            Log.Warn("Specifying showDotCursor as a RFB constructor argument is deprecated");
            this._showDotCursor = options.showDotCursor;
        }

        this._qualityLevel = 6;
    }

    // ===== PROPERTIES =====

    get viewOnly() { return this._viewOnly; }
    set viewOnly(viewOnly) {
        this._viewOnly = viewOnly;

        if (this._rfb_connection_state === "connecting" ||
            this._rfb_connection_state === "connected") {
            if (viewOnly) {
                this._keyboard.ungrab();
                this._mouse.ungrab();
            } else {
                this._keyboard.grab();
                this._mouse.grab();
            }
        }
    }

    get capabilities() { return this._capabilities; }

    get touchButton() { return this._mouse.touchButton; }
    set touchButton(button) { this._mouse.touchButton = button; }

    get clipViewport() { return this._clipViewport; }
    set clipViewport(viewport) {
        this._clipViewport = viewport;
        this._updateClip();
    }

    get scaleViewport() { return this._scaleViewport; }
    set scaleViewport(scale) {
        this._scaleViewport = scale;
        // Scaling trumps clipping, so we may need to adjust
        // clipping when enabling or disabling scaling
        if (scale && this._clipViewport) {
            this._updateClip();
        }
        this._updateScale();
        if (!scale && this._clipViewport) {
            this._updateClip();
        }
    }

    get resizeSession() { return this._resizeSession; }
    set resizeSession(resize) {
        this._resizeSession = resize;
        if (resize) {
            this._requestRemoteResize();
        }
    }

    get showDotCursor() { return this._showDotCursor; }
    set showDotCursor(show) {
        this._showDotCursor = show;
        this._refreshCursor();
    }

    get background() { return this._screen.style.background; }
    set background(cssValue) { this._screen.style.background = cssValue; }

    get qualityLevel() {
        return this._qualityLevel;
    }
    set qualityLevel(qualityLevel) {
        if (!Number.isInteger(qualityLevel) || qualityLevel < 0 || qualityLevel > 9) {
            Log.Error("qualityLevel must be an integer between 0 and 9");
            return;
        }

        if (this._qualityLevel === qualityLevel) {
            return;
        }

        this._qualityLevel = qualityLevel;

        if (this._rfb_connection_state === 'connected') {
            this._sendEncodings();
        }
    }

    // ===== PUBLIC METHODS =====

    disconnect() {
        this._updateConnectionState('disconnecting');
        this._sock.off('error');
        this._sock.off('message');
        this._sock.off('open');
    }

    sendCredentials(creds) {
        this._rfb_credentials = creds;
        this._negotiate_std_vnc_auth();
    }

    sendCtrlAltDel() {
        if (this._rfb_connection_state !== 'connected' || this._viewOnly) { return; }
        Log.Info("Sending Ctrl-Alt-Del");

        this.sendKey(KeyTable.XK_Control_L, "ControlLeft", true);
        this.sendKey(KeyTable.XK_Alt_L, "AltLeft", true);
        this.sendKey(KeyTable.XK_Delete, "Delete", true);
        this.sendKey(KeyTable.XK_Delete, "Delete", false);
        this.sendKey(KeyTable.XK_Alt_L, "AltLeft", false);
        this.sendKey(KeyTable.XK_Control_L, "ControlLeft", false);
    }

    machineShutdown() {
    }

    machineReboot() {
    }

    machineReset() {
    }

    // Send a key press. If 'down' is not specified then send a down key
    // followed by an up key.
    sendKey(keysym, code, down) {
        if (this._rfb_connection_state !== 'connected' || this._viewOnly) { return; }

        if (down === undefined) {
            this.sendKey(keysym, code, true);
            this.sendKey(keysym, code, false);
            return;
        }

        const scancode = XtScancode[code];

        if (this._qemuExtKeyEventSupported && scancode) {
            // 0 is NoSymbol
            keysym = keysym || 0;

            Log.Info("Sending key (" + (down ? "down" : "up") + "): keysym " + keysym + ", scancode " + scancode);

            RFB.messages.QEMUExtendedKeyEvent(this._sock, keysym, down, scancode);
        } else {
            if (!keysym) {
                return;
            }
            Log.Info("Sending keysym (" + (down ? "down" : "up") + "): " + keysym);
            RFB.messages.keyEvent(this._sock, keysym, down ? 1 : 0);
        }
    }

    focus() {
        this._canvas.focus();
    }

    blur() {
        this._canvas.blur();
    }

    clipboardPasteFrom(text) {
        if (this._rfb_connection_state !== 'connected' || this._viewOnly) { return; }

        if (this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] &&
            this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]) {

            this._clipboardText = text;
            RFB.messages.extendedClipboardNotify(this._sock, [extendedClipboardFormatText]);
        } else {
            let data = new Uint8Array(text.length);
            for (let i = 0; i < text.length; i++) {
                // FIXME: text can have values outside of Latin1/Uint8
                data[i] = text.charCodeAt(i);
            }

            RFB.messages.clientCutText(this._sock, data);
        }
    }

    // ===== PRIVATE METHODS =====

    _connect() {
        Log.Debug(">> RFB.connect");

        Log.Info("connecting to " + this._url);

        try {
            // WebSocket.onopen transitions to the RFB init states
            this._sock.open(this._url, this._wsProtocols);
        } catch (e) {
            if (e.name === 'SyntaxError') {
                this._fail("Invalid host or port (" + e + ")");
            } else {
                this._fail("Error when opening socket (" + e + ")");
            }
        }

        // Make our elements part of the page
        this._target.appendChild(this._screen);

        this._cursor.attach(this._canvas);
        this._refreshCursor();

        // Monitor size changes of the screen
        // FIXME: Use ResizeObserver, or hidden overflow
        window.addEventListener('resize', this._eventHandlers.windowResize);

        // Always grab focus on some kind of click event
        this._canvas.addEventListener("mousedown", this._eventHandlers.focusCanvas);
        this._canvas.addEventListener("touchstart", this._eventHandlers.focusCanvas);

        Log.Debug("<< RFB.connect");
    }

    _disconnect() {
        Log.Debug(">> RFB.disconnect");
        this._cursor.detach();
        this._canvas.removeEventListener("mousedown", this._eventHandlers.focusCanvas);
        this._canvas.removeEventListener("touchstart", this._eventHandlers.focusCanvas);
        window.removeEventListener('resize', this._eventHandlers.windowResize);
        this._keyboard.ungrab();
        this._mouse.ungrab();
        this._sock.close();
        try {
            this._target.removeChild(this._screen);
        } catch (e) {
            if (e.name === 'NotFoundError') {
                // Some cases where the initial connection fails
                // can disconnect before the _screen is created
            } else {
                throw e;
            }
        }
        clearTimeout(this._resizeTimeout);
        Log.Debug("<< RFB.disconnect");
    }

    _focusCanvas(event) {
        // Respect earlier handlers' request to not do side-effects
        if (event.defaultPrevented) {
            return;
        }

        if (!this.focusOnClick) {
            return;
        }

        this.focus();
    }

    _setDesktopName(name) {
        this._fb_name = name;
        this.dispatchEvent(new CustomEvent(
            "desktopname",
            { detail: { name: this._fb_name } }));
    }

    _windowResize(event) {
        // If the window resized then our screen element might have
        // as well. Update the viewport dimensions.
        window.requestAnimationFrame(() => {
            this._updateClip();
            this._updateScale();
        });

        if (this._resizeSession) {
            // Request changing the resolution of the remote display to
            // the size of the local browser viewport.

            // In order to not send multiple requests before the browser-resize
            // is finished we wait 0.5 seconds before sending the request.
            clearTimeout(this._resizeTimeout);
            this._resizeTimeout = setTimeout(this._requestRemoteResize.bind(this), 500);
        }
    }

    // Update state of clipping in Display object, and make sure the
    // configured viewport matches the current screen size
    _updateClip() {
        const cur_clip = this._display.clipViewport;
        let new_clip = this._clipViewport;

        if (this._scaleViewport) {
            // Disable viewport clipping if we are scaling
            new_clip = false;
        }

        if (cur_clip !== new_clip) {
            this._display.clipViewport = new_clip;
        }

        if (new_clip) {
            // When clipping is enabled, the screen is limited to
            // the size of the container.
            const size = this._screenSize();
            this._display.viewportChangeSize(size.w, size.h);
            this._fixScrollbars();
        }
    }

    _updateScale() {
        if (!this._scaleViewport) {
            this._display.scale = 1.0;
        } else {
            const size = this._screenSize();
            this._display.autoscale(size.w, size.h);
        }
        this._fixScrollbars();
    }

    // Requests a change of remote desktop size. This message is an extension
    // and may only be sent if we have received an ExtendedDesktopSize message
    _requestRemoteResize() {
        clearTimeout(this._resizeTimeout);
        this._resizeTimeout = null;

        if (!this._resizeSession || this._viewOnly ||
            !this._supportsSetDesktopSize) {
            return;
        }

        const size = this._screenSize();
        RFB.messages.setDesktopSize(this._sock,
                                    Math.floor(size.w), Math.floor(size.h),
                                    this._screen_id, this._screen_flags);

        Log.Debug('Requested new desktop size: ' +
                   size.w + 'x' + size.h);
    }

    // Gets the the size of the available screen
    _screenSize() {
        let r = this._screen.getBoundingClientRect();
        return { w: r.width, h: r.height };
    }

    _fixScrollbars() {
        // This is a hack because Chrome screws up the calculation
        // for when scrollbars are needed. So to fix it we temporarily
        // toggle them off and on.
        const orig = this._screen.style.overflow;
        this._screen.style.overflow = 'hidden';
        // Force Chrome to recalculate the layout by asking for
        // an element's dimensions
        this._screen.getBoundingClientRect();
        this._screen.style.overflow = orig;
    }

    /*
     * Connection states:
     *   connecting
     *   connected
     *   disconnecting
     *   disconnected - permanent state
     */
    _updateConnectionState(state) {
        const oldstate = this._rfb_connection_state;

        if (state === oldstate) {
            Log.Debug("Already in state '" + state + "', ignoring");
            return;
        }

        // The 'disconnected' state is permanent for each RFB object
        if (oldstate === 'disconnected') {
            Log.Error("Tried changing state of a disconnected RFB object");
            return;
        }

        // Ensure proper transitions before doing anything
        switch (state) {
            case 'connected':
                if (oldstate !== 'connecting') {
                    Log.Error("Bad transition to connected state, " +
                               "previous connection state: " + oldstate);
                    return;
                }
                break;

            case 'disconnected':
                if (oldstate !== 'disconnecting') {
                    Log.Error("Bad transition to disconnected state, " +
                               "previous connection state: " + oldstate);
                    return;
                }
                break;

            case 'connecting':
                if (oldstate !== '') {
                    Log.Error("Bad transition to connecting state, " +
                               "previous connection state: " + oldstate);
                    return;
                }
                break;

            case 'disconnecting':
                if (oldstate !== 'connected' && oldstate !== 'connecting') {
                    Log.Error("Bad transition to disconnecting state, " +
                               "previous connection state: " + oldstate);
                    return;
                }
                break;

            default:
                Log.Error("Unknown connection state: " + state);
                return;
        }

        // State change actions

        this._rfb_connection_state = state;

        Log.Debug("New state '" + state + "', was '" + oldstate + "'.");

        if (this._disconnTimer && state !== 'disconnecting') {
            Log.Debug("Clearing disconnect timer");
            clearTimeout(this._disconnTimer);
            this._disconnTimer = null;

            // make sure we don't get a double event
            this._sock.off('close');
        }

        switch (state) {
            case 'connecting':
                this._connect();
                break;

            case 'connected':
                this.dispatchEvent(new CustomEvent("connect", { detail: {} }));
                break;

            case 'disconnecting':
                this._disconnect();

                this._disconnTimer = setTimeout(() => {
                    Log.Error("Disconnection timed out.");
                    this._updateConnectionState('disconnected');
                }, DISCONNECT_TIMEOUT * 1000);
                break;

            case 'disconnected':
                this.dispatchEvent(new CustomEvent(
                    "disconnect", { detail:
                                    { clean: this._rfb_clean_disconnect } }));
                break;
        }
    }

    /* Print errors and disconnect
     *
     * The parameter 'details' is used for information that
     * should be logged but not sent to the user interface.
     */
    _fail(details) {
        switch (this._rfb_connection_state) {
            case 'disconnecting':
                Log.Error("Failed when disconnecting: " + details);
                break;
            case 'connected':
                Log.Error("Failed while connected: " + details);
                break;
            case 'connecting':
                Log.Error("Failed when connecting: " + details);
                break;
            default:
                Log.Error("RFB failure: " + details);
                break;
        }
        this._rfb_clean_disconnect = false; //This is sent to the UI

        // Transition to disconnected without waiting for socket to close
        this._updateConnectionState('disconnecting');
        this._updateConnectionState('disconnected');

        return false;
    }

    _setCapability(cap, val) {
        this._capabilities[cap] = val;
        this.dispatchEvent(new CustomEvent("capabilities",
                                           { detail: { capabilities: this._capabilities } }));
    }

    _handle_message(msg) {
        switch (this._rfb_connection_state) {
            case 'disconnected':
                Log.Error("Got data while disconnected");
                break;
            case 'connected':
                while (true) {
                    if (this._flushing) {
                        break;
                    }
                    if (!this._normal_msg(msg)) {
                        break;
                    }
                }
                break;
            default:
                this._init_msg(msg);
                break;
        }
    }

    _handleKeyEvent(keysym, code, down) {
        this.sendKey(keysym, code, down);
    }

    _handleMouseButton(x, y, down, bmask) {
        if (down) {
            this._mouse_buttonMask |= bmask;
        } else {
            this._mouse_buttonMask &= ~bmask;
        }

        if (this.dragViewport) {
            if (down && !this._viewportDragging) {
                this._viewportDragging = true;
                this._viewportDragPos = {'x': x, 'y': y};
                this._viewportHasMoved = false;

                // Skip sending mouse events
                return;
            } else {
                this._viewportDragging = false;

                // If we actually performed a drag then we are done
                // here and should not send any mouse events
                if (this._viewportHasMoved) {
                    return;
                }

                // Otherwise we treat this as a mouse click event.
                // Send the button down event here, as the button up
                // event is sent at the end of this function.
                RFB.messages.pointerEvent(this._sock,
                                          this._display.absX(x),
                                          this._display.absY(y),
                                          bmask);
            }
        }

        if (this._viewOnly) { return; } // View only, skip mouse events

        if (this._rfb_connection_state !== 'connected') { return; }
        RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
    }

    _handleMouseMove(x, y) {
        if (this._viewportDragging) {
            const deltaX = this._viewportDragPos.x - x;
            const deltaY = this._viewportDragPos.y - y;

            if (this._viewportHasMoved || (Math.abs(deltaX) > dragThreshold ||
                                           Math.abs(deltaY) > dragThreshold)) {
                this._viewportHasMoved = true;

                this._viewportDragPos = {'x': x, 'y': y};
                this._display.viewportChangePos(deltaX, deltaY);
            }

            // Skip sending mouse events
            return;
        }

        if (this._viewOnly) { return; } // View only, skip mouse events

        if (this._rfb_connection_state !== 'connected') { return; }
        RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
    }

    // Message Handlers

    _handle_security_reason() {
        if (this._sock.rQwait("reason length", 4)) {
            return false;
        }
        const strlen = this._sock.rQshift32();
        let reason = "";

        if (strlen > 0) {
            if (this._sock.rQwait("reason", strlen, 4)) { return false; }
            reason = this._sock.rQshiftStr(strlen);
        }

        if (reason !== "") {
            this.dispatchEvent(new CustomEvent(
                "securityfailure",
                { detail: { status: this._security_status,
                            reason: reason } }));

            return this._fail("Security negotiation failed on " +
                              this._security_context +
                              " (reason: " + reason + ")");
        } else {
            this.dispatchEvent(new CustomEvent(
                "securityfailure",
                { detail: { status: this._security_status } }));

            return this._fail("Security negotiation failed on " +
                              this._security_context);
        }
    }

    _negotiate_server_init(server_info) {
        this._server_info = server_info;
        const { username, displays } = server_info;
        let width, height;
        if (displays) {
            displays.forEach((d) => {
                if (!d.primary) return;
                width = d.width;
                height = d.height;
                server_info.primary = d.name;
            });
        }
        Log.Info("Screen: " + width + "x" + height);

        // we're past the point where we could backtrack, so it's safe to call this
        this._setDesktopName(username);
        this._resize(width, height);

        if (!this._viewOnly) { this._keyboard.grab(); }
        if (!this._viewOnly) { this._mouse.grab(); }

        this._updateConnectionState('connected');
    }

    _init_msg(msg) {
        if (msg.challenge) {
            this.challenge = this._challenge;
            this._negotiate_std_vnc_auth();
        } else if (msg.login_response) {
            const { error, server_info } = msg.login_response;
            if (error) {
                this.dispatchEvent(new CustomEvent(
                    "securityfailure",
                    { detail: { status: error } }));
                return this._fail("Login failed: " + error);
            } else if (server_info) {
                this._negotiate_server_init(server_info);
            }
        }
    }

    _negotiate_std_vnc_auth() {
        if (this._rfb_credentials.password === undefined) {
            this.dispatchEvent(new CustomEvent(
                "credentialsrequired",
                { detail: { types: ["password"] } }));
            return false;
        }

        // TODO(directxman12): make genDES not require an Array
        let password = RFB.genDES(this._rfb_credentials.password, this._challenge);
        password = new TextDecoder().decode(new Uint8Array(password)); 
        this._sock.send({
            login_request: {
                password
            }
        });
        return true;
    }

    _handle_set_colour_map_msg() {
        Log.Debug("SetColorMapEntries");

        return this._fail("Unexpected SetColorMapEntries message");
    }

    _handle_server_cut_text() {
        Log.Debug("ServerCutText");

        if (this._sock.rQwait("ServerCutText header", 7, 1)) { return false; }

        this._sock.rQskipBytes(3);  // Padding

        let length = this._sock.rQshift32();
        length = toSigned32bit(length);

        if (this._sock.rQwait("ServerCutText content", Math.abs(length), 8)) { return false; }

        if (length >= 0) {
            //Standard msg
            const text = this._sock.rQshiftStr(length);
            if (this._viewOnly) {
                return true;
            }

            this.dispatchEvent(new CustomEvent(
                "clipboard",
                { detail: { text: text } }));

        } else {
            //Extended msg.
            length = Math.abs(length);
            const flags = this._sock.rQshift32();
            let formats = flags & 0x0000FFFF;
            let actions = flags & 0xFF000000;

            let isCaps = (!!(actions & extendedClipboardActionCaps));
            if (isCaps) {
                this._clipboardServerCapabilitiesFormats = {};
                this._clipboardServerCapabilitiesActions = {};

                // Update our server capabilities for Formats
                for (let i = 0; i <= 15; i++) {
                    let index = 1 << i;

                    // Check if format flag is set.
                    if ((formats & index)) {
                        this._clipboardServerCapabilitiesFormats[index] = true;
                        // We don't send unsolicited clipboard, so we
                        // ignore the size
                        this._sock.rQshift32();
                    }
                }

                // Update our server capabilities for Actions
                for (let i = 24; i <= 31; i++) {
                    let index = 1 << i;
                    this._clipboardServerCapabilitiesActions[index] = !!(actions & index);
                }

                /*  Caps handling done, send caps with the clients
                    capabilities set as a response */
                let clientActions = [
                    extendedClipboardActionCaps,
                    extendedClipboardActionRequest,
                    extendedClipboardActionPeek,
                    extendedClipboardActionNotify,
                    extendedClipboardActionProvide
                ];
                RFB.messages.extendedClipboardCaps(this._sock, clientActions, {extendedClipboardFormatText: 0});

            } else if (actions === extendedClipboardActionRequest) {
                if (this._viewOnly) {
                    return true;
                }

                // Check if server has told us it can handle Provide and there is clipboard data to send.
                if (this._clipboardText != null &&
                    this._clipboardServerCapabilitiesActions[extendedClipboardActionProvide]) {

                    if (formats & extendedClipboardFormatText) {
                        RFB.messages.extendedClipboardProvide(this._sock, [extendedClipboardFormatText], [this._clipboardText]);
                    }
                }

            } else if (actions === extendedClipboardActionPeek) {
                if (this._viewOnly) {
                    return true;
                }

                if (this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]) {

                    if (this._clipboardText != null) {
                        RFB.messages.extendedClipboardNotify(this._sock, [extendedClipboardFormatText]);
                    } else {
                        RFB.messages.extendedClipboardNotify(this._sock, []);
                    }
                }

            } else if (actions === extendedClipboardActionNotify) {
                if (this._viewOnly) {
                    return true;
                }

                if (this._clipboardServerCapabilitiesActions[extendedClipboardActionRequest]) {

                    if (formats & extendedClipboardFormatText) {
                        RFB.messages.extendedClipboardRequest(this._sock, [extendedClipboardFormatText]);
                    }
                }

            } else if (actions === extendedClipboardActionProvide) {
                if (this._viewOnly) {
                    return true;
                }

                if (!(formats & extendedClipboardFormatText)) {
                    return true;
                }
                // Ignore what we had in our clipboard client side.
                this._clipboardText = null;

                // FIXME: Should probably verify that this data was actually requested
                let zlibStream = this._sock.rQshiftBytes(length - 4);
                let streamInflator = new Inflator();
                let textData = null;

                streamInflator.setInput(zlibStream);
                for (let i = 0; i <= 15; i++) {
                    let format = 1 << i;

                    if (formats & format) {

                        let size = 0x00;
                        let sizeArray = streamInflator.inflate(4);

                        size |= (sizeArray[0] << 24);
                        size |= (sizeArray[1] << 16);
                        size |= (sizeArray[2] << 8);
                        size |= (sizeArray[3]);
                        let chunk = streamInflator.inflate(size);

                        if (format === extendedClipboardFormatText) {
                            textData = chunk;
                        }
                    }
                }
                streamInflator.setInput(null);

                if (textData !== null) {
                    let tmpText = "";
                    for (let i = 0; i < textData.length; i++) {
                        tmpText += String.fromCharCode(textData[i]);
                    }
                    textData = tmpText;

                    textData = decodeUTF8(textData);
                    if ((textData.length > 0) && "\0" === textData.charAt(textData.length - 1)) {
                        textData = textData.slice(0, -1);
                    }

                    textData = textData.replace("\r\n", "\n");

                    this.dispatchEvent(new CustomEvent(
                        "clipboard",
                        { detail: { text: textData } }));
                }
            } else {
                return this._fail("Unexpected action in extended clipboard message: " + actions);
            }
        }
        return true;
    }

    _normal_msg(msg) {
        let msg_type;
        if (this._FBU.rects > 0) {
            msg_type = 0;
        } else {
            msg_type = this._sock.rQshift8();
        }

        let first, ret;
        switch (msg_type) {
            case 0:  // FramebufferUpdate
                ret = this._framebufferUpdate();
                if (ret && !this._enabledContinuousUpdates) {
                    RFB.messages.fbUpdateRequest(this._sock, true, 0, 0,
                                                 this._fb_width, this._fb_height);
                }
                return ret;

            case 1:  // SetColorMapEntries
                return this._handle_set_colour_map_msg();

            case 2:  // Bell
                Log.Debug("Bell");
                this.dispatchEvent(new CustomEvent(
                    "bell",
                    { detail: {} }));
                return true;

            case 3:  // ServerCutText
                return this._handle_server_cut_text();

            case 150: // EndOfContinuousUpdates
                first = !this._supportsContinuousUpdates;
                this._supportsContinuousUpdates = true;
                this._enabledContinuousUpdates = false;
                if (first) {
                    this._enabledContinuousUpdates = true;
                    this._updateContinuousUpdates();
                    Log.Info("Enabling continuous updates.");
                } else {
                    // FIXME: We need to send a framebufferupdaterequest here
                    // if we add support for turning off continuous updates
                }
                return true;

            case 248: // ServerFence
                return this._handle_server_fence_msg();

            default:
                this._fail("Unexpected server message (type " + msg_type + ")");
                Log.Debug("sock.rQslice(0, 30): " + this._sock.rQslice(0, 30));
                return true;
        }
    }

    _onFlush() {
        this._flushing = false;
    }

    _framebufferUpdate() {
        if (this._FBU.rects === 0) {
            if (this._sock.rQwait("FBU header", 3, 1)) { return false; }
            this._sock.rQskipBytes(1);  // Padding
            this._FBU.rects = this._sock.rQshift16();

            // Make sure the previous frame is fully rendered first
            // to avoid building up an excessive queue
            if (this._display.pending()) {
                this._flushing = true;
                this._display.flush();
                return false;
            }
        }

        while (this._FBU.rects > 0) {
            if (this._FBU.encoding === null) {
                if (this._sock.rQwait("rect header", 12)) { return false; }
                /* New FramebufferUpdate */

                const hdr = this._sock.rQshiftBytes(12);
                this._FBU.x        = (hdr[0] << 8) + hdr[1];
                this._FBU.y        = (hdr[2] << 8) + hdr[3];
                this._FBU.width    = (hdr[4] << 8) + hdr[5];
                this._FBU.height   = (hdr[6] << 8) + hdr[7];
                this._FBU.encoding = parseInt((hdr[8] << 24) + (hdr[9] << 16) +
                                              (hdr[10] << 8) + hdr[11], 10);
            }

            if (!this._handleRect()) {
                return false;
            }

            this._FBU.rects--;
            this._FBU.encoding = null;
        }

        this._display.flip();

        return true;  // We finished this FBU
    }

    _handleRect() {
        switch (this._FBU.encoding) {
            case encodings.pseudoEncodingLastRect:
                this._FBU.rects = 1; // Will be decreased when we return
                return true;

            case encodings.pseudoEncodingVMwareCursor:
                return this._handleVMwareCursor();

            case encodings.pseudoEncodingCursor:
                return this._handleCursor();

            case encodings.pseudoEncodingQEMUExtendedKeyEvent:
                // Old Safari doesn't support creating keyboard events
                try {
                    const keyboardEvent = document.createEvent("keyboardEvent");
                    if (keyboardEvent.code !== undefined) {
                        this._qemuExtKeyEventSupported = true;
                    }
                } catch (err) {
                    // Do nothing
                }
                return true;

            case encodings.pseudoEncodingDesktopSize:
                this._resize(this._FBU.width, this._FBU.height);
                return true;

            case encodings.pseudoEncodingExtendedDesktopSize:
                return this._handleExtendedDesktopSize();

            default:
                return this._handleDataRect();
        }
    }

    _handleVMwareCursor() {
        const hotx = this._FBU.x;  // hotspot-x
        const hoty = this._FBU.y;  // hotspot-y
        const w = this._FBU.width;
        const h = this._FBU.height;
        if (this._sock.rQwait("VMware cursor encoding", 1)) {
            return false;
        }

        const cursor_type = this._sock.rQshift8();

        this._sock.rQshift8(); //Padding

        let rgba;
        const bytesPerPixel = 4;

        //Classic cursor
        if (cursor_type == 0) {
            //Used to filter away unimportant bits.
            //OR is used for correct conversion in js.
            const PIXEL_MASK = 0xffffff00 | 0;
            rgba = new Array(w * h * bytesPerPixel);

            if (this._sock.rQwait("VMware cursor classic encoding",
                                  (w * h * bytesPerPixel) * 2, 2)) {
                return false;
            }

            let and_mask = new Array(w * h);
            for (let pixel = 0; pixel < (w * h); pixel++) {
                and_mask[pixel] = this._sock.rQshift32();
            }

            let xor_mask = new Array(w * h);
            for (let pixel = 0; pixel < (w * h); pixel++) {
                xor_mask[pixel] = this._sock.rQshift32();
            }

            for (let pixel = 0; pixel < (w * h); pixel++) {
                if (and_mask[pixel] == 0) {
                    //Fully opaque pixel
                    let bgr = xor_mask[pixel];
                    let r   = bgr >> 8  & 0xff;
                    let g   = bgr >> 16 & 0xff;
                    let b   = bgr >> 24 & 0xff;

                    rgba[(pixel * bytesPerPixel)     ] = r;    //r
                    rgba[(pixel * bytesPerPixel) + 1 ] = g;    //g
                    rgba[(pixel * bytesPerPixel) + 2 ] = b;    //b
                    rgba[(pixel * bytesPerPixel) + 3 ] = 0xff; //a

                } else if ((and_mask[pixel] & PIXEL_MASK) ==
                           PIXEL_MASK) {
                    //Only screen value matters, no mouse colouring
                    if (xor_mask[pixel] == 0) {
                        //Transparent pixel
                        rgba[(pixel * bytesPerPixel)     ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 1 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 2 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 3 ] = 0x00;

                    } else if ((xor_mask[pixel] & PIXEL_MASK) ==
                               PIXEL_MASK) {
                        //Inverted pixel, not supported in browsers.
                        //Fully opaque instead.
                        rgba[(pixel * bytesPerPixel)     ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 1 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 2 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 3 ] = 0xff;

                    } else {
                        //Unhandled xor_mask
                        rgba[(pixel * bytesPerPixel)     ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 1 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 2 ] = 0x00;
                        rgba[(pixel * bytesPerPixel) + 3 ] = 0xff;
                    }

                } else {
                    //Unhandled and_mask
                    rgba[(pixel * bytesPerPixel)     ] = 0x00;
                    rgba[(pixel * bytesPerPixel) + 1 ] = 0x00;
                    rgba[(pixel * bytesPerPixel) + 2 ] = 0x00;
                    rgba[(pixel * bytesPerPixel) + 3 ] = 0xff;
                }
            }

        //Alpha cursor.
        } else if (cursor_type == 1) {
            if (this._sock.rQwait("VMware cursor alpha encoding",
                                  (w * h * 4), 2)) {
                return false;
            }

            rgba = new Array(w * h * bytesPerPixel);

            for (let pixel = 0; pixel < (w * h); pixel++) {
                let data = this._sock.rQshift32();

                rgba[(pixel * 4)     ] = data >> 24 & 0xff; //r
                rgba[(pixel * 4) + 1 ] = data >> 16 & 0xff; //g
                rgba[(pixel * 4) + 2 ] = data >> 8 & 0xff;  //b
                rgba[(pixel * 4) + 3 ] = data & 0xff;       //a
            }

        } else {
            Log.Warn("The given cursor type is not supported: "
                      + cursor_type + " given.");
            return false;
        }

        this._updateCursor(rgba, hotx, hoty, w, h);

        return true;
    }

    _handleCursor() {
        const hotx = this._FBU.x;  // hotspot-x
        const hoty = this._FBU.y;  // hotspot-y
        const w = this._FBU.width;
        const h = this._FBU.height;

        const pixelslength = w * h * 4;
        const masklength = Math.ceil(w / 8) * h;

        let bytes = pixelslength + masklength;
        if (this._sock.rQwait("cursor encoding", bytes)) {
            return false;
        }

        // Decode from BGRX pixels + bit mask to RGBA
        const pixels = this._sock.rQshiftBytes(pixelslength);
        const mask = this._sock.rQshiftBytes(masklength);
        let rgba = new Uint8Array(w * h * 4);

        let pix_idx = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let mask_idx = y * Math.ceil(w / 8) + Math.floor(x / 8);
                let alpha = (mask[mask_idx] << (x % 8)) & 0x80 ? 255 : 0;
                rgba[pix_idx    ] = pixels[pix_idx + 2];
                rgba[pix_idx + 1] = pixels[pix_idx + 1];
                rgba[pix_idx + 2] = pixels[pix_idx];
                rgba[pix_idx + 3] = alpha;
                pix_idx += 4;
            }
        }

        this._updateCursor(rgba, hotx, hoty, w, h);

        return true;
    }

    _handleDesktopName() {
        if (this._sock.rQwait("DesktopName", 4)) {
            return false;
        }

        let length = this._sock.rQshift32();

        if (this._sock.rQwait("DesktopName", length, 4)) {
            return false;
        }

        let name = this._sock.rQshiftStr(length);
        name = decodeUTF8(name, true);


        return true;
    }

    _handleExtendedDesktopSize() {
        if (this._sock.rQwait("ExtendedDesktopSize", 4)) {
            return false;
        }

        const number_of_screens = this._sock.rQpeek8();

        let bytes = 4 + (number_of_screens * 16);
        if (this._sock.rQwait("ExtendedDesktopSize", bytes)) {
            return false;
        }

        const firstUpdate = !this._supportsSetDesktopSize;
        this._supportsSetDesktopSize = true;

        // Normally we only apply the current resize mode after a
        // window resize event. However there is no such trigger on the
        // initial connect. And we don't know if the server supports
        // resizing until we've gotten here.
        if (firstUpdate) {
            this._requestRemoteResize();
        }

        this._sock.rQskipBytes(1);  // number-of-screens
        this._sock.rQskipBytes(3);  // padding

        for (let i = 0; i < number_of_screens; i += 1) {
            // Save the id and flags of the first screen
            if (i === 0) {
                this._screen_id = this._sock.rQshiftBytes(4);    // id
                this._sock.rQskipBytes(2);                       // x-position
                this._sock.rQskipBytes(2);                       // y-position
                this._sock.rQskipBytes(2);                       // width
                this._sock.rQskipBytes(2);                       // height
                this._screen_flags = this._sock.rQshiftBytes(4); // flags
            } else {
                this._sock.rQskipBytes(16);
            }
        }

        /*
         * The x-position indicates the reason for the change:
         *
         *  0 - server resized on its own
         *  1 - this client requested the resize
         *  2 - another client requested the resize
         */

        // We need to handle errors when we requested the resize.
        if (this._FBU.x === 1 && this._FBU.y !== 0) {
            let msg = "";
            // The y-position indicates the status code from the server
            switch (this._FBU.y) {
                case 1:
                    msg = "Resize is administratively prohibited";
                    break;
                case 2:
                    msg = "Out of resources";
                    break;
                case 3:
                    msg = "Invalid screen layout";
                    break;
                default:
                    msg = "Unknown reason";
                    break;
            }
            Log.Warn("Server did not accept the resize request: "
                     + msg);
        } else {
            this._resize(this._FBU.width, this._FBU.height);
        }

        return true;
    }

    _handleDataRect() {
        let decoder = this._decoders[this._FBU.encoding];
        if (!decoder) {
            this._fail("Unsupported encoding (encoding: " +
                       this._FBU.encoding + ")");
            return false;
        }

        try {
            return decoder.decodeRect(this._FBU.x, this._FBU.y,
                                      this._FBU.width, this._FBU.height,
                                      this._sock, this._display,
                                      this._fb_depth);
        } catch (err) {
            this._fail("Error decoding rect: " + err);
            return false;
        }
    }

    _resize(width, height) {
        this._fb_width = width;
        this._fb_height = height;

        this._display.resize(this._fb_width, this._fb_height);

        // Adjust the visible viewport based on the new dimensions
        this._updateClip();
        this._updateScale();
    }

    _updateCursor(rgba, hotx, hoty, w, h) {
        this._cursorImage = {
            rgbaPixels: rgba,
            hotx: hotx, hoty: hoty, w: w, h: h,
        };
        this._refreshCursor();
    }

    _shouldShowDotCursor() {
        // Called when this._cursorImage is updated
        if (!this._showDotCursor) {
            // User does not want to see the dot, so...
            return false;
        }

        // The dot should not be shown if the cursor is already visible,
        // i.e. contains at least one not-fully-transparent pixel.
        // So iterate through all alpha bytes in rgba and stop at the
        // first non-zero.
        for (let i = 3; i < this._cursorImage.rgbaPixels.length; i += 4) {
            if (this._cursorImage.rgbaPixels[i]) {
                return false;
            }
        }

        // At this point, we know that the cursor is fully transparent, and
        // the user wants to see the dot instead of this.
        return true;
    }

    _refreshCursor() {
        if (this._rfb_connection_state !== "connecting" &&
            this._rfb_connection_state !== "connected") {
            return;
        }
        const image = this._shouldShowDotCursor() ? RFB.cursors.dot : this._cursorImage;
        this._cursor.change(image.rgbaPixels,
                            image.hotx, image.hoty,
                            image.w, image.h
        );
    }

    static genDES(password, challenge) {
        const passwordChars = password.split('').map(c => c.charCodeAt(0));
        const challengeChars = challenge.split('').map(c => c.charCodeAt(0));
        return (new DES(passwordChars)).encrypt(challengeChars);
    }
}

// Class Methods
RFB.messages = {
    keyEvent(sock, keysym, down) {
        const buff = sock._sQ;
        const offset = sock._sQlen;

        buff[offset] = 4;  // msg-type
        buff[offset + 1] = down;

        buff[offset + 2] = 0;
        buff[offset + 3] = 0;

        buff[offset + 4] = (keysym >> 24);
        buff[offset + 5] = (keysym >> 16);
        buff[offset + 6] = (keysym >> 8);
        buff[offset + 7] = keysym;

        sock._sQlen += 8;
        sock.flush();
    },

    QEMUExtendedKeyEvent(sock, keysym, down, keycode) {
        function getRFBkeycode(xt_scancode) {
            const upperByte = (keycode >> 8);
            const lowerByte = (keycode & 0x00ff);
            if (upperByte === 0xe0 && lowerByte < 0x7f) {
                return lowerByte | 0x80;
            }
            return xt_scancode;
        }

        const buff = sock._sQ;
        const offset = sock._sQlen;

        buff[offset] = 255; // msg-type
        buff[offset + 1] = 0; // sub msg-type

        buff[offset + 2] = (down >> 8);
        buff[offset + 3] = down;

        buff[offset + 4] = (keysym >> 24);
        buff[offset + 5] = (keysym >> 16);
        buff[offset + 6] = (keysym >> 8);
        buff[offset + 7] = keysym;

        const RFBkeycode = getRFBkeycode(keycode);

        buff[offset + 8] = (RFBkeycode >> 24);
        buff[offset + 9] = (RFBkeycode >> 16);
        buff[offset + 10] = (RFBkeycode >> 8);
        buff[offset + 11] = RFBkeycode;

        sock._sQlen += 12;
        sock.flush();
    },

    pointerEvent(sock, x, y, mask) {
        const buff = sock._sQ;
        const offset = sock._sQlen;

        buff[offset] = 5; // msg-type

        buff[offset + 1] = mask;

        buff[offset + 2] = x >> 8;
        buff[offset + 3] = x;

        buff[offset + 4] = y >> 8;
        buff[offset + 5] = y;

        sock._sQlen += 6;
        sock.flush();
    },

    // Used to build Notify and Request data.
    _buildExtendedClipboardFlags(actions, formats) {
        let data = new Uint8Array(4);
        let formatFlag = 0x00000000;
        let actionFlag = 0x00000000;

        for (let i = 0; i < actions.length; i++) {
            actionFlag |= actions[i];
        }

        for (let i = 0; i < formats.length; i++) {
            formatFlag |= formats[i];
        }

        data[0] = actionFlag >> 24; // Actions
        data[1] = 0x00;             // Reserved
        data[2] = 0x00;             // Reserved
        data[3] = formatFlag;       // Formats

        return data;
    },

    extendedClipboardProvide(sock, formats, inData) {
        // Deflate incomming data and their sizes
        let deflator = new Deflator();
        let dataToDeflate = [];

        for (let i = 0; i < formats.length; i++) {
            // We only support the format Text at this time
            if (formats[i] != extendedClipboardFormatText) {
                throw new Error("Unsupported extended clipboard format for Provide message.");
            }

            // Change lone \r or \n into \r\n as defined in rfbproto
            inData[i] = inData[i].replace(/\r\n|\r|\n/gm, "\r\n");

            // Check if it already has \0
            let text = encodeUTF8(inData[i] + "\0");

            dataToDeflate.push( (text.length >> 24) & 0xFF,
                                (text.length >> 16) & 0xFF,
                                (text.length >>  8) & 0xFF,
                                (text.length & 0xFF));

            for (let j = 0; j < text.length; j++) {
                dataToDeflate.push(text.charCodeAt(j));
            }
        }

        let deflatedData = deflator.deflate(new Uint8Array(dataToDeflate));

        // Build data  to send
        let data = new Uint8Array(4 + deflatedData.length);
        data.set(RFB.messages._buildExtendedClipboardFlags([extendedClipboardActionProvide],
                                                           formats));
        data.set(deflatedData, 4);

        RFB.messages.clientCutText(sock, data, true);
    },

    extendedClipboardNotify(sock, formats) {
        let flags = RFB.messages._buildExtendedClipboardFlags([extendedClipboardActionNotify],
                                                              formats);
        RFB.messages.clientCutText(sock, flags, true);
    },

    extendedClipboardRequest(sock, formats) {
        let flags = RFB.messages._buildExtendedClipboardFlags([extendedClipboardActionRequest],
                                                              formats);
        RFB.messages.clientCutText(sock, flags, true);
    },

    extendedClipboardCaps(sock, actions, formats) {
        let formatKeys = Object.keys(formats);
        let data  = new Uint8Array(4 + (4 * formatKeys.length));

        formatKeys.map(x => parseInt(x));
        formatKeys.sort((a, b) =>  a - b);

        data.set(RFB.messages._buildExtendedClipboardFlags(actions, []));

        let loopOffset = 4;
        for (let i = 0; i < formatKeys.length; i++) {
            data[loopOffset]     = formats[formatKeys[i]] >> 24;
            data[loopOffset + 1] = formats[formatKeys[i]] >> 16;
            data[loopOffset + 2] = formats[formatKeys[i]] >> 8;
            data[loopOffset + 3] = formats[formatKeys[i]] >> 0;

            loopOffset += 4;
            data[3] |= (1 << formatKeys[i]); // Update our format flags
        }

        RFB.messages.clientCutText(sock, data, true);
    },

    clientCutText(sock, data, extended = false) {
        const buff = sock._sQ;
        const offset = sock._sQlen;

        buff[offset] = 6; // msg-type

        buff[offset + 1] = 0; // padding
        buff[offset + 2] = 0; // padding
        buff[offset + 3] = 0; // padding

        let length;
        if (extended) {
            length = toUnsigned32bit(-data.length);
        } else {
            length = data.length;
        }

        buff[offset + 4] = length >> 24;
        buff[offset + 5] = length >> 16;
        buff[offset + 6] = length >> 8;
        buff[offset + 7] = length;

        sock._sQlen += 8;

        // We have to keep track of from where in the data we begin creating the
        // buffer for the flush in the next iteration.
        let dataOffset = 0;

        let remaining = data.length;
        while (remaining > 0) {

            let flushSize = Math.min(remaining, (sock._sQbufferSize - sock._sQlen));
            for (let i = 0; i < flushSize; i++) {
                buff[sock._sQlen + i] = data[dataOffset + i];
            }

            sock._sQlen += flushSize;
            sock.flush();

            remaining -= flushSize;
            dataOffset += flushSize;
        }

    },
};

RFB.cursors = {
    none: {
        rgbaPixels: new Uint8Array(),
        w: 0, h: 0,
        hotx: 0, hoty: 0,
    },

    dot: {
        /* eslint-disable indent */
        rgbaPixels: new Uint8Array([
            255, 255, 255, 255,   0,   0,   0, 255, 255, 255, 255, 255,
              0,   0,   0, 255,   0,   0,   0,   0,   0,   0,  0,  255,
            255, 255, 255, 255,   0,   0,   0, 255, 255, 255, 255, 255,
        ]),
        /* eslint-enable indent */
        w: 3, h: 3,
        hotx: 1, hoty: 1,
    }
};
