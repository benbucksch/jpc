
function start(callRemote, registerIncomingCall) {
  registerIncomingCall("class", registerRemoteClass);
  registerIncomingCall("new", newObjListener);
  registerIncomingCall("func", funcListener);
  registerIncomingCall("get", getterListener);
  registerIncomingCall("set", setterListener);
  registerIncomingCall("del", payload => {
    deleteLocalObject(payload.idRemote);
  });
  gRemoteObjectRegistry = new FinalizationRegistry(id => {
    callRemote("del", null, {
      idRemote: id,
    }).catch(console.error);
  });
}


///////////////////////////////////////////
// Stub object
// A local JS object representing a remote object

/**
 * { Map className {string} -> prototype object {obj} }
 */
var gRemoteClasses = new Map();

class RemoteClass {
  constructor(className) {
    this.className = className;
  }
}

/**
 * Generates a stub class
 *
 * @param classDescrJSON {JSON} Describes the remote class, see PROTOCOL.md
 */
function registerRemoteClass(classDescrJSON) {
  let existing = this._classes.get(classDescrJSON.className);
  if (existing) {
    return existing;
  }

  let parent;
  if (classDescrJSON.extends) {
    parent = this._classes.get(classDescrJSON.extends);
    if (!parent) {
      throw new Error(`Super class ${ objDescrJSON.extends } is unknown here. Make sure to first push the super class description before the subclass description.`);
    }
  }

  let proto;
  if (parent) {
    proto = Object.create(parent);
    proto.className = classDescrJSON.className;
  } else {
    proto = new RemoteClass(classDescrJSON.className);
  }
  for (let func of classDescrJSON.functions) {
    proto[func.name] = makeFunction(func.name);
  }
  for (let getter of classDescrJSON.getters) {
    Object.defineProperty(proto, getter, {
      enumerable: true,
      writable: false,
      get: makeGetter(getter.name),
    });
    let setterName = "set" + getterName[0].toUpperCase() + getter.name.substr(1);
    proto[setterName] = makeSetter(getter.name);
  }
  proto.newRemote = makeNewObj(classDescrJSON.className); // TODO static function
  this._classes.set(classDescrJSON.className, proto);
}

// not actually used
class StubObject {
  constructor() {
    this.id = addRemoteObject(this);
  }
}

/**
 * Generates a stub object instance
 *
 * @param objDescrJSON {JSON} Describes the remote object, see PROTOCOL.md
 * @returns {StubObj}
 */
function makeStub(objDescrJSON) {
  let proto = gRemoteClasses.get(objDescrJSON.className);
  if (!proto) {
    throw new Error(`Remote class ${ objDescrJSON.className } is unknown here. Make sure to first push the class description.`);
  }
  let stub = Object.create(proto);
  stub.id = addRemoteObject(stub);
  for (let propName in objDescrJSON.properties) {
    stub[propName] = objDescrJSON.properties[propName];
  }
  return stub;
}

function makeFunction(functionName) {
  // this == stub object
  return (...args) => callRemote("func", "func-r", {
    id: this.id,
    name: functionName,
    args: args,
  });
}

function makeGetter(propName) {
  // this == stub object
  return () => callRemote("get", "set-r", {
    id: this.id,
    name: propName,
  });
}

function makeSetter(propName) {
  // this == stub object
  return val => callRemote("set", "set-r", {
    id: this.id,
    name: propName,
    value: val,
  });
}

function makeNewObj(className) {
  return (...args) => callRemote("new", "new-r", {
    className: className,
    args: args,
  });
}

/**
 * @param value {any} string, number, boolean,
 *   array, JSON obj,
 *   Object description or Object references, as defined by PROTOCOL.md
 * @return {any} same as value, just Object descriptions and Object references
 *   replaced with `StubObject`s.
 */
function mapIncomingObjects(value) {
  if (typeof(value) == "string" ||
      typeof(value) == "number" ||
      typeof(value) == "boolean") {
    return value;
  } else if (Array.isArray(value)) {
    return value.map(el => mapIncomingObjects(el));
  } else if (typeof(value) == "object") {
    if (value.id && value.className) { // object description
      return makeStub(value);
    } else if (value.idRemote) {
      return getLocalObject(value.idRemote);
    } else if (value.idLocal) {
      return getRemoteObject(value.idLocal);
    }
  }
}


///////////////////////////////////////////
// Local object
// Passing a normal local JS object to the remote side

async function newObjListener(callID, payload) {
  if (typeof(payload.className) != "string") {
    throw new Error("Need class name");
  }
  let classCtor = global[payload.className];
  let obj;
  let args = payload.args;
  if (typeof(args) == "undefined") {
    obj = classCtor();
  } else {
    if (!Array.isArray(args))) {
      throw new Error("Constructor arguments must be an array of values");
    }
    args = mapIncomingObjects(args);
    obj = classCtor(...args);
  }
  let id = getIDForLocalObject(obj);
  await callRemote("new-r", {
    obj: createObjectDescription(obj, getNewIDForLocalObject(obj)),
    call: callID,
  });
}

async function funcListener(callID, payload) {
  let name = payload.name;
  if (typeof(name) != "string") {
    throw new Error("Need function name");
  }
  if (typeof(payload.obj) != "string") {
    throw new Error("Need object ID");
  }
  let obj = getLocalObject(payload.obj);
  let args = mapIncomingObjects(payload.args);

  // may throw
  let result = obj[name](...args);

  await callRemote("func-r", {
    result: mapOutgoingObjects(result),
    call: callID,
  });
}

async function getterListener(callID, payload) {
  let name = payload.name;
  if (typeof(name) != "string") {
    throw new Error("Need property getter name");
  }
  if (typeof(payload.obj) != "string") {
    throw new Error("Need object ID");
  }
  let obj = getLocalObject(payload.obj);

  // may throw
  let value = obj[name];

  await callRemote("get-r", {
    value: mapOutgoingObjects(value),
    call: callID,
  });
}

async function setterListener(callID, payload) {
  let name = payload.name;
  if (typeof(name) != "string") {
    throw new Error("Need property setter name");
  }
  if (typeof(payload.obj) != "string") {
    throw new Error("Need object ID");
  }
  let obj = getLocalObject(payload.obj);
  let value = mapIncomingObjects(payload.value);

  // may throw
  obj[payload.name] = value;

  await callRemote("set-r", {
    call: callID,
  });
}

/**
 * @param value {any} string, number, boolean,
 *   array, JSON obj, or
 *   local JS object
 * @return {any} same as value, just local objects replaced with
 *   Object descriptions and Object references, as defined by PROTOCOL.md
 */
function mapOutgoingObjects(value) {
  if (typeof(value) == "string" ||
      typeof(value) == "number" ||
      typeof(value) == "boolean") {
    return value;
  } else if (Array.isArray(value)) {
    return value.map(el => mapOutgoingObjects(el));
  } else if (typeof(value) == "object") {
    console.log("Sending object", value);
    if (value instanceof RemoteClass) { // TODO check working?
      return { // Object reference for remote object
        idRemote: value.id,
      };
    }

    if (value.constructor.name == "Object") { // JSON object -- TODO better way to check?
      let json = {};
      for (let propName of value.keys()) {
        json[propName] = mapOutgoingObjects(value[propName]);
      }
      return json;
    }

    let id = getExistingIDForLocalObject(value);
    if (id) {
      return { // Object reference for local object
        idLocal: id,
      };
    }

    return createObjectDescription(value, getNewIDForLocalObject(obj));
  }
}

/**
 * @param obj {Object} local object
 * @returns {JSON} Object description, see PROTOCOL.md
 */
function createObjectDescription(obj, id) {
  let props = null;
  for (let propName in obj) {
    if (propName.startsWith("_")) {
      continue;
    }
    props[propName] = obj[propName];
  }
  let className = obj.constructor.name;
  if (!className) {
    throw new Error("Could not find class name for local object");
  }
  return {
    id: id,
    className: className,
    properties: props,
  };
}


///////////////////////////////////////////////
// ID to objects

/**
 * {Map ID {string} -> remoteObject {StubObject} }
 */
var gRemoteObjects = new Map();
/**
 * {Map ID {string} -> localObject {obj} }
 */
var gLocalIDsToObjects = new Map();
/**
 * {Map localObj {obj} -> ID {string} }
 */
var gLocalObjectsToIDs = new Map();

function generateObjID() {
  return Math.round(Math.random() * 10^20) + "";
}

/**
 * @param id {string} ID of object refererence
 * @returns {StubObj} remote object
 */
function getRemoteObject(id) {
  let obj = gRemoteObjects.get(id);
  if (!obj) {
    throw new Error(`Remote object with ID ${ id } is unknown here.`);
  }
  return obj;
}

/**
 * @param id {string} ID of object refererence
 * @returns {obj} local object
 */
function getLocalObject(id) {
  let obj = gLocalIDsToObjects.get(id);
  if (!obj) {
    throw new Error(`Local object with ID ${ id } is unknown here.`);
  }
  return obj;
}

/**
 * @param obj {Object} Local object
 * @returns {string} ID
 */
function getExistingIDForLocalObject(obj) {
  return gLocalObjectsToIDs.get(obj);
}

/**
 * @param obj {Object} Local object
 * @returns {string} ID
 */
function getNewIDForLocalObject(obj) {
  do {
    id = generateObjID();
  } while (gLocalIDsToObjects.has(id))
  gLocalIDsToObjects.set(id, obj);
  gLocalObjectsToIDs.set(obj, id);
  return id;
}

/**
 * @param id {string} ID for remote object, as set by the remote side
 * @param obj {StubObj} Remote object
 */
function addRemoteObject(id, obj) {
  let obj = gRemoteObjects.get(id);
  if (obj) {
    throw new Error(`Remote object ID ${ id } already exists.`);
  }
  gRemoteObjects.set(id, obj);
  gRemoteObjectRegistry.register(obj, id);
}

/**
 * Remote side says that it no longer needs this object.
 * Drop the reference to it.
 * @param id {string} ID of object refererence
 */
function deleteRemoteObject(id) {
  let obj = gRemoteObjects.get(id);
  if (!obj) {
    throw new Error(`Remote object with ID ${ id } is unknown here.`);
  }
  gRemoteObjects.delete(id);
}

/**
 * Remote side says that it no longer needs this object.
 * Drop the reference to it.
 * @param id {string} ID of object refererence
 */
function deleteLocalObject(id) {
  let obj = gLocalIDsToObjects.get(id);
  if (!obj) {
    throw new Error(`Local object with ID ${ id } is unknown here.`);
  }
  gLocalIDsToObjects.delete(id);
  gLocalObjectsToIDs.delete(obj);
}

var gRemoteObjectRegistry;
