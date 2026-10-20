import WebSocket from "ws";
import EventEmitter from "events";
import { promises as fs } from "fs";

import { Events, SocketErrors } from "./constants.js";
import Utils from "./utils.js";

export default class UlanziApi extends EventEmitter {
  constructor() {
    super();

    this.key = "";
    this.uuid = "";
    this.actionid = "";
    this.websocket = null;
    // language = 'en';
    // localization = null;
    // localPathPrefix = '../../langs/';
    // on = EventEmitter.on;
    // emit = EventEmitter.emit;
  }

  connect(uuid, port = 3906, address = "127.0.0.1") {
    //Get IP and port dynamically
    const [argv_address, argv_port, argv_language] = process.argv.splice(2);

    this.address = argv_address || address;
    this.port = argv_port || port;
    this.language = Utils.adaptLanguage(argv_language || "en");

    this.uuid = uuid;

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    //Check whether this is the main service: by convention the main service uuid has 4 segments, actions have more
    const isMain = this.uuid.split(".").length == 4;

    this.websocket = new WebSocket(`ws://${this.address}:${this.port}`);

    this.websocket.onopen = () => {
      Utils.log(`[ULANZIDECK] MAIN WEBSOCKET OPEN: ${this.uuid}`);
      const json = {
        code: 0,
        cmd: Events.CONNECTED,
        uuid: this.uuid,
      };

      this.websocket.send(JSON.stringify(json));

      this.emit(Events.CONNECTED, {});

      //If this is the main service, skip localization
      if (!isMain) {
        // this.localizeUI();  //node: no localization
      }
    };

    this.websocket.onerror = (evt) => {
      const error = `[ULANZIDECK] MAIN WEBSOCKET ERROR: ${JSON.stringify(
        evt
      )}, ${JSON.stringify(evt.data)}, ${SocketErrors[evt?.code || "DEFAULT"]}`;
      Utils.warn(error);

      this.emit(Events.ERROR, error);
    };

    this.websocket.onclose = (evt) => {
      Utils.warn(
        `[ULANZIDECK] MAIN WEBSOCKET CLOSED: ${this.uuid}, ${
          SocketErrors[evt?.code || "DEFAULT"]
        }`
      );
      this.emit(Events.CLOSE);
    };

    this.websocket.onmessage = (evt) => {
      Utils.log("[ULANZIDECK] MAIN WEBSOCKET MESSGE ");

      let data = null;
      try { data = evt?.data ? JSON.parse(evt.data) : null; } catch { return; } // drop malformed frames instead of crashing

      Utils.log(
        `[ULANZIDECK] MAIN WEBSOCKET MESSGE DATA: ${
          this.uuid
        }, ${JSON.stringify(data)}`
      );

      //Return if there is no data, or data has a code property and cmdType is not REQUEST
      if (
        !data ||
        (typeof data.code !== "undefined" && data.cmdType !== "REQUEST")
      )
        return;

      Utils.log("[ULANZIDECK] MAIN WEBSOCKET MESSGE IN");

      //Save the key if not set yet
      if (!this.key && data.uuid == this.uuid && data.key) {
        this.key = data.key;
      }
      //Save the actionid if not set yet
      if (!this.actionid && data.uuid == this.uuid && data.actionid) {
        this.actionid = data.actionid;
      }

      if (isMain) {
        //Main service replies to the host app
        this.send(data.cmd, {
          code: 0,
          ...data,
        });
      }

      //Special handling for clear, since the clear event param is an array
      if (data.cmd == "clear") {
        if (data.param) {
          for (let i = 0; i < data.param.length; i++) {
            const context = this.encodeContext(data.param[i]);
            data.param[i].context = context;
          }
        }
      } else {
        //Build the unique id for the action page
        const context = this.encodeContext(data);
        data.context = context;
      }

      //Emit the event
      this.emit(data.cmd, data);
    };
  }

  /**
   * Localization
   */
  async localizeUI() {
    if (!this.localization) {
      try {
        const filePath = `${Utils.getPluginPath()}/${this.language}.json`
        const data = await fs.readFile(filePath, 'utf8');
        const localJson = JSON.parse(data);
        this.localization = localJson["Localization"] ?? null;
        
        // Utils.log(`---get ${Utils.getPluginPath()}/${this.language}.json success--`);
      } catch (e) {
        // Utils.log(`-- ${Utils.getPluginPath()}/${this.language}.json fail --error:`, e);
        Utils.warn(`[ULANZIDECK] No FILE found to localize ${this.language}`);
      }
    }
  }

  t(key) {
    // console.log('--localization---key:', key, this.localization && this.localization[key],JSON.stringify(this.localization));
    return (this.localization && this.localization[key]) || key;
  }

  /**
   * Create a unique id
   */
  encodeContext(jsn) {
    return jsn.uuid + "___" + jsn.key + "___" + jsn.actionid;
  }

  /**
   * Parse a unique id
   */
  decodeContext(context) {
    const de_ctx = context.split("___");
    return {
      uuid: de_ctx[0],
      key: de_ctx[1],
      actionid: de_ctx[2],
    };
  }

  /**
   * Send JSON params to StreamDeck
   * @param {string} cmd
   * @param {object} params
   */
  send(cmd, params) {
    console.warn(`[ULANZIDECK] send:  ${JSON.stringify({
          cmd,
          uuid: this.uuid,
          key: this.key,
          actionid: this.actionid,
          ...params,
        })}`);
    this.websocket && this.websocket.readyState === WebSocket.OPEN &&
      this.websocket.send(
        JSON.stringify({
          cmd,
          uuid: this.uuid,
          key: this.key,
          actionid: this.actionid,
          ...params,
        })
      );
  }

  /**
   * Send settings to the host app (Ulanzi Studio)
   * @param {object} settings required | settings
   * @param {object} context optional | unique id. Optional when sent from the action page; required when sent from the main service
   */
  sendParamFromPlugin(settings, context) {
    const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
    this.send(Events.PARAMFROMPLUGIN, {
      uuid: uuid || this.uuid,
      key: key || this.key,
      actionid: actionid || this.actionid,
      param: settings,
    });
  }

  /**
   * Ask the host app to open a url in the browser
   * @param {string} url required | remote or local address; supports urls under the plugin root (starting with / or ./).
   *                           Base path only, no query params; put params in param instead
   * @param {local} boolean optional | true if the address is local
   * @param {object} param optional | query params for the path
   */
  openUrl(url, local, param) {
    this.send(Events.OPENURL, {
      url,
      local: local ? true : false,
      param: param ? param : null,
    });
  }

  /**
   * Ask the host app to show a popup window; test.html must close itself, window.close() notifies the popup to close
   *  @param {string} url required | local html path; base path only, no query params; put params in param instead
   * @param {string} width optional | window width, default 200
   * @param {string} height optional | window height, default 200
   * @param {string} x optional | window x coordinate, centered by default
   * @param {string} y optional | window y coordinate, centered by default
   * @param {object} param optional | query params for the path
   */
  openView(url, width = 200, height = 200, x, y, param) {
    const params = {
      url,
      width,
      height,
    };
    if (x) {
      params.x = x;
    }
    if (y) {
      params.y = y;
    }
    if (param) {
      params.param = param;
    }
    this.send(Events.OPENVIEW, params);
  }

  /**
   * Ask the host app to show a toast message
   *  @param {string} msg required | window-level message
   */
  toast(msg) {
    this.send(Events.TOAST, {
      msg,
    });
  }
  
  /**
   * Ask the host app to trigger a hotkey
   *  @param {string} key required | hotkey
   */
  hotkey(key) {
    this.send(Events.HOTKEY, {
      keylist: key,
    });
  }

  /**
   * Ask the host app to write a log message
   *  @param {string} msg required | saved to <plugin UUID>.txt
   *  @param {string} level optional | log level info|debug|warn|error
   */
  logMessage(msg, level) {
    this.send(Events.LOGMESSAGE, {
      message: msg,
      level: level || "info",
    });
  }
  /**
   *  Sent by the main service; the host app passes params through to the action page without saving them
   *  @param {object} settings required | settings
   *  @param {string} context required | unique id of the target action
   */
  sendToPropertyInspector(settings, context) {
    const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
    this.send(Events.SENDTOPROPERTYINSPECTOR, {
      uuid: uuid,
      key: key,
      actionid: actionid,
      payload: settings,
    });
  }

  /**
   *  Sent by the action page; the host app passes params through to the main service without saving them
   *  @param {object} settings required | settings
   */
  sendToPlugin(settings) {
    this.send(Events.SENDTOPLUGIN, {
      uuid: this.uuid,
      key: this.key,
      actionid: this.actionid,
      payload: settings,
    });
  }

  /**
   * Ask the host app to show an error indicator on the key
   *  @param {string} context optional | unique id. Optional when sent from the action page; required when sent from the main service
   */
  showAlert(context) {
    const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
    this.send(Events.SHOWALERT, {
      uuid: uuid || this.uuid,
      key: key || this.key,
      actionid: actionid || this.actionid,
    });
  }

  /**
   * Ask the host app to send saved settings; it then fires didReceiveSettings to the other side
   *  @param {string} context optional | unique id. Optional when sent from the action page; required when sent from the main service
   */
  getSettings(context) {
    const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
    this.send(Events.GETSETTINGS, {
      uuid: uuid || this.uuid,
      key: key || this.key,
      actionid: actionid || this.actionid,
    });
  }

  /**
   * Save settings to the host app; it then fires didReceiveSettings to the other side
   *  @param {object} settings required | settings
   *  @param {string} context optional | unique id. Optional when sent from the action page; required when sent from the main service
   */
  setSettings(settings, context) {
    console.warn('===---setSettings:', JSON.stringify(settings), context)
    const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
    this.send(Events.SETSETTINGS, {
      uuid: uuid || this.uuid,
      key: key || this.key,
      actionid: actionid || this.actionid,
      settings,
    });
  }

     /**
     * Ask the host app to send saved global settings; it then fires didReceiveGlobalSettings to the other side
     *  @param {string} context optional | unique id. Optional when sent from the action page; required when sent from the main service
     */
    getGlobalSettings(context) {
      const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
      this.send(Events.GETGLOBALSETTINGS, {
        uuid: uuid || this.uuid,
        key: key || this.key,
        actionid: actionid || this.actionid,
      });
    }
  
    /**
     * Save global settings to the host app; it then fires didReceiveGlobalSettings to the other side
     *  @param {object} settings required | settings
     *  @param {string} context optional | unique id. Optional when sent from the action page; required when sent from the main service
     */
    setGlobalSettings(settings, context) {
      const { uuid, key, actionid } = context ? this.decodeContext(context) : {};
      this.send(Events.SETGLOBALSETTINGS, {
        uuid: uuid || this.uuid,
        key: key || this.key,
        actionid: actionid || this.actionid,
        settings,
      });
    }

  /**
   * Ask the host app to open a selection dialog: select file
   *  @param {string} filter optional | file type filter, e.g. "filter": "image(*.jpg *.png *.gif)" or file(*.txt *.json)
   * The selection result is delivered via the onSelectdialog event
   */
  selectFileDialog(filter) {
    this.send(Events.SELECTDIALOG, {
      type: "file",
      filter,
    });
  }

  /**
   * Ask the host app to open a selection dialog: select folder
   * The selection result is delivered via the onSelectdialog event
   */
  selectFolderDialog() {
    this.send(Events.SELECTDIALOG, {
      type: "folder",
    });
  }

  /**
   * Set the active state for an action instance.
   * @param {string} context Required | Target action context
   * @param {number} state Required | State index from manifest.json
   */
  setState(context, state) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETSTATE, {
      param: { uuid, key, actionid, state },
    });
  }

  /**
   * Set runtime images for an action instance.
   * @param {string} context Required | Target action context
   * @param {object} options Required | Protocol fields: isDefault, icons, or clear
   */
  setImage(context, options) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETIMAGE, {
      param: { uuid, key, actionid, ...(options || {}) },
    });
  }

  /**
   * Set the title for an action instance.
   * @param {string} context Required | Target action context
   * @param {string} text Required | Title text
   */
  setTitle(context, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETTITLE, {
      param: { uuid, key, actionid, text },
    });
  }

  /**
   * Set a built-in encoder feedback layout.
   * Custom layout files are not supported by protocol V3.1.0.
   * @param {string} context Required | Target encoder action context
   * @param {string} layout Required | Built-in layout identifier, such as $UA1
   */
  setFeedbackLayout(context, layout) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETFEEDBACKLAYOUT, { uuid, key, actionid, layout });
  }

  /**
   * Update elements in the current encoder feedback layout.
   * @param {string} context Required | Target encoder action context
   * @param {object} layout Required | Layout element values keyed by element name
   */
  setFeedback(context, layout) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.SETFEEDBACK, { uuid, key, actionid, layout });
  }

  /**
   * Set icon - use an icon index from the configured list (see manifest.json)
   * @param {string} context required | unique id; the common lib fills it in automatically for each message
   * @param {number} state required | icon list index
   * @param {string} text optional | text to show on the icon
   */
  setStateIcon(context, state, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 0,
            state,
            textData: text || "",
            showtext: text ? true : false,
          },
        ],
      },
    });
  }

  /**
   * Set icon - use a custom icon
   * @param {string} context required | unique id; the common lib fills it in automatically for each message
   * @param {string} data required | base64 icon
   * @param {string} text optional | text to show on the icon
   */
  setBaseDataIcon(context, data, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 1,
            data,
            textData: text || "",
            showtext: text ? true : false,
          },
        ],
      },
    });
  }

  /**
   * Set icon - use a local image file
   * @param {string} context required | unique id; the common lib fills it in automatically for each message
   * @param {string} path  required | local image path; supports paths under the plugin root (starting with / or ./)
   * @param {string} text optional | text to show on the icon
   */
  setPathIcon(context, path, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 2,
            path,
            textData: text || "",
            showtext: text ? true : false,
          },
        ],
      },
    });
  }

  /**
   * Set icon - use a custom animated gif
   * @param {string} context required | unique id; the common lib fills it in automatically for each message
   * @param {string} gifdata  required | base64-encoded custom gif data
   * @param {string} text optional | text to show on the icon
   */
  setGifDataIcon(context, gifdata, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 3,
            gifdata,
            textData: text || "",
            showtext: text ? true : false,
          },
        ],
      },
    });
  }

  /**
   * Set icon - use a local gif file
   * @param {string} context required | unique id; the common lib fills it in automatically for each message
   * @param {string} gifdata  required | local gif path; supports paths under the plugin root (starting with / or ./)
   * @param {string} text optional | text to show on the icon
   */
  setGifPathIcon(context, gifpath, text) {
    const { uuid, key, actionid } = this.decodeContext(context);
    this.send(Events.STATE, {
      param: {
        statelist: [
          {
            uuid,
            key,
            actionid,
            type: 4,
            gifpath,
            textData: text || "",
            showtext: text ? true : false,
          },
        ],
      },
    });
  }

  /**
   * Listen for the socket connected event
   * @param {import('../apiTypes.d.ts').OnConnected} fn
   */
  onConnected(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the connected event is required for onConnected."
      );
    }

    this.on(Events.CONNECTED, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Listen for the socket closed event
   * @param {import('../apiTypes.d.ts').OnClose} fn
   */
  onClose(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the close event is required for onClose."
      );
    }

    this.on(Events.CLOSE, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Listen for the socket error event
   * @param {import('../apiTypes.d.ts').OnError} fn
   */
  onError(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the error event is required for onError."
      );
    }

    this.on(Events.ERROR, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: add
   * @param {import('../apiTypes.d.ts').OnCmdAddResp} fn
   */
  onAdd(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the add event is required for onAdd."
      );
    }

    this.on(Events.ADD, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: paramfromapp
   * @param {import('../apiTypes.d.ts').OnCmdParamFromAppResp} fn
   */
  onParamFromApp(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the paramfromapp event is required for onParamFromApp."
      );
    }

    this.on(Events.PARAMFROMAPP, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: paramfromplugin
   * @param {import('../apiTypes.d.ts').OnCmdParamFromPluginResp} fn
   */
  onParamFromPlugin(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the paramfromplugin event is required for onParamFromPlugin."
      );
    }

    this.on(Events.PARAMFROMPLUGIN, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: run
   * @param {import('../apiTypes.d.ts').OnCmdRunResp} fn
   */
  onRun(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the run event is required for onRun."
      );
    }

    this.on(Events.RUN, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: setactive
   * @param {import('../apiTypes.d.ts').OnCmdSetActiveResp} fn
   */
  onSetActive(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the setactive event is required for onSetActive."
      );
    }

    this.on(Events.SETACTIVE, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: clear
   * @param {import('../apiTypes.d.ts').OnCmdClearResp} fn
   */
  onClear(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the clear event is required for onClear."
      );
    }

    this.on(Events.CLEAR, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: selection dialog result
   * @param {import('../apiTypes.d.ts').OnCmdSelectDialogResp} fn
   */
  onSelectdialog(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the selectdialog event is required for onSelectdialog."
      );
    }

    this.on(Events.SELECTDIALOG, (jsn) => fn(jsn));
    return this;
  }
  
  /**
   * Host app event: didReceiveSettings, settings saved by the host app
   */
  onDidReceiveSettings(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the didReceiveSettings event is required for onDidReceiveSettings."
      );
    }
    this.on(Events.DIDRECEIVESETTINGS, (jsn) => fn(jsn));
    return this;
  }

  
   /**
   * didReceiveGlobalSettings, global settings
   */
  onDidReceiveGlobalSettings(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the didReceiveGlobalSettings event is required for onDidReceiveGlobalSettings."
      );
    }
    this.on(Events.DIDRECEIVEGLOBALSETTINGS, (jsn) => fn(jsn));
    return this;
  }

    /**
   * 
   * Pass-through params from the main service to the action page
   */
  onSendToPropertyInspector(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the sendToPropertyInspector event is required for onSendToPropertyInspector."
      );
    }
    this.on(Events.SENDTOPROPERTYINSPECTOR, (jsn) => fn(jsn));
    return this;
  }

  /**
   * 
   * Pass-through params from the action page to the main service
   */
  onSendToPlugin(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the sendToPlugin event is required for onSendToPlugin."
      );
    }
    this.on(Events.SENDTOPLUGIN, (jsn) => fn(jsn));
    return this;
  }

  /**
   * Host app event: keydown, key pressed
   */
  onKeyDown(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the keydown event is required for onKeyDown."
      );
    }
    this.on(Events.KEYDOWN, (jsn) => fn(jsn));
    return this;
  }
  /**
   * Host app event: keyup, key released
   */
  onKeyUp(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the keyup event is required for onKeyUp."
      );
    }
    this.on(Events.KEYUP, (jsn) => fn(jsn));
    return this;
  }
  /**
   * Host app event: dialdown, dial pressed
   */
  onDialDown(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialdown event is required for onDialDown."
      );
    }
    this.on(Events.DIALEDOWN, (jsn) => fn(jsn));
    return this;
  }
  /**
   * Host app event: dialup, dial released
   */
  onDialUp(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialup event is required for onDialUp."
      );
    }
    this.on(Events.DIALEUP, (jsn) => fn(jsn));
    return this;
  }
  /**
   * Host app event: dialrotate, dial rotated left
   */
  onDialRotateLeft(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialrotate left event is required for onDialRotateLeft."
      );
    }
    this.on(Events.DIALROTATE, (jsn) => {
      if (jsn.rotateEvent === "left") {
        fn(jsn);
      }
    });
    return this;
  }

  /**
   * Host app event: dialrotate, dial rotated right
   */
  onDialRotateRight(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialrotate right event is required for onDialRotateRight."
      );
    }
    this.on(Events.DIALROTATE, (jsn) => {
      if (jsn.rotateEvent === "right") {
        fn(jsn);
      }
    });
    return this;
  }

  /**
   * Host app event: dialrotate, dial rotated left while held
   */
  onDialRotateHoldLeft(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialrotate hold-left event is required for onDialRotateHoldLeft."
      );
    }
    this.on(Events.DIALROTATE, (jsn) => {
      if (jsn.rotateEvent === "hold-left") {
        fn(jsn);
      }
    });
    return this;
  }

  /**
   * Host app event: dialrotate, dial rotated right while held
   */
  onDialRotateHoldRight(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialrotate hold-right event is required for onDialRotateHoldRight."
      );
    }
    this.on(Events.DIALROTATE, (jsn) => {
      // Note: the original data had a typo "hold—right"; the correct hyphen is used here
      if (jsn.rotateEvent === "hold-right") {
        fn(jsn);
      }
    });
    return this;
  }

  /**
   * Host app event: dialrotate, dial rotated
   */
  onDialRotate(fn) {
    if (!fn) {
      Utils.error(
        "A callback function for the dialrotate event is required for onDialRotate."
      );
    }
    this.on(Events.DIALROTATE, (jsn) => fn(jsn));
    return this;
  }
}
