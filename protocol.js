/***************************************
 * Wire protocol API
 */

/**
 * Incoming calls.
 * Implements the wire protocol.
 *
 * @param method {string} the message name, e.g. "func-r", "get-r" etc.
 * @param listener {Function(callID {string}, payload {JSON}}
 * If listener throws, sends the error message to the caller at the remote end.
 */
function registerIncomingCall(method, listener) {
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
async function callRemote(method, responseMethod, payload) {
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
