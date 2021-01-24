import { start } from "./obj.js";

/**
 * Wire protocol API
 */
export default class JPCProtocol {
  /**
   * @param startObject {Object} Will be returned to client in "start" function
   */
  constructor(startObject) {
    this._startObject = startObject;
  }

  /**
   * Call this before calling any of the other functions.
   *
   * @param startObject {Object} Will be returned to client in "start" function
   */
  async init() {
    start(this, this._startObject);
  }

  /**
   * Incoming calls.
   * Implements the wire protocol.
   *
   * @param method {string} the message name, e.g. "func", "get", "func-r" etc.
   * @param listener {async function(payload {JSON}}
   * What the listener function returns is sent back as result to the caller.
   * If listener throws, sends the error message to the caller at the remote end.
   */
  registerIncomingCall(method, listener) {
    throw new Error("Implement this");
  }

  /**
   * Outgoing calls.
   * Implements the wire protocol.
   *
   * @param method {string} the message name, e.g. "func", "get" etc.
   * @param responseMethod {string} (optional)
   *    if given, wait for the remote side to respond with this method,
   *    and return the payload of `responseMethod`.
   * @param payload {JSON} see value in PROTOCOL.md
   * @returns {any} see value in PROTOCOL.md
   *   The payload of the corresponding `responseMethod` answer.
   *   If `responseMethod` is not given, returns null/undefined.
   * @throws {Error} if:
   *   - the remote end threw an exception
   *   - the connection disappeared
   */
  async callRemote(method, responseMethod, payload) {
    throw new Error("Implement this");

    let callID = responseMethod ? Math.random() * 10^20 : 0;
    payload.callID = callID;
    await TODO(method, payload);
    if (responseMethod) {
      //return await waitForIncomingCall(responseMethod, callID);
      return new Promise((resolved, rejected) => {
        let unregister = registerIncomingCall(responseMethod, payload => {
          if (payload.callID != callID) {
            return;
          }
          unregister();
          resolved(payload);
        });
      });
    }
  }
}
