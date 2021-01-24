import { assert } from "./util.js";

/**
 * Called by the wire protocol implementation,
 * before calling any of the other functions.
 *
 * @param jpcProtocol {JPCProtocol} Wire protocol implementation
 */
export function start(jpcProtocol, startObject) {
  callRemote = (...args) => jpcProtocol.callRemote(...args);
  jpcProtocol.registerIncomingCall("class", registerRemoteClass);
  jpcProtocol.registerIncomingCall("start", () => startObject);
  jpcProtocol.registerIncomingCall("new", newObjListener);
  jpcProtocol.registerIncomingCall("func", funcListener);
  jpcProtocol.registerIncomingCall("get", getterListener);
  jpcProtocol.registerIncomingCall("set", setterListener);
  jpcProtocol.registerIncomingCall("del", payload => {
    deleteLocalObject(payload.idRemote);
  });
  if ("FinalizationRegistry" in global) {
    gRemoteObjectRegistry = new FinalizationRegistry(id => {
      jpcProtocol.callRemote("del", null, {
        idRemote: id,
      }).catch(console.error);
    });
  } else { // not supported, use dummy
    gRemoteObjectRegistry = {
      register: () => {},
    };
  }
}

var callRemote;

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
    assert(parent, `Super class ${ objDescrJSON.extends } is unknown here. Make sure to first push the super class description before the subclass description.`);
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
  assert(proto, `Remote class ${ objDescrJSON.className } is unknown here. Make sure to first push the class description.`);
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
    obj: this.id,
    name: functionName,
    args: args,
  });
}

function makeGetter(propName) {
  // this == stub object
  return () => callRemote("get", "set-r", {
    obj: this.id,
    name: propName,
  });
}

function makeSetter(propName) {
  // this == stub object
  return val => callRemote("set", "set-r", {
    obj: this.id,
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

async function newObjListener(payload) {
  assert(typeof(payload.className) == "string", "Need class name");
  let classCtor = global[payload.className];
  let obj;
  let args = payload.args;
  if (typeof(args) == "undefined") {
    obj = classCtor();
  } else {
    assert(Array.isArray(args), "Constructor arguments must be an array of values");
    args = mapIncomingObjects(args);
    obj = classCtor(...args);
  }

  return createObjectDescription(obj, getNewIDForLocalObject(obj));
}

async function funcListener(payload) {
  let name = payload.name;
  assert(typeof(name) == "string", "Need function name");
  assert(typeof(payload.obj) == "string", "Need object ID");
  let obj = getLocalObject(payload.obj);
  let args = mapIncomingObjects(payload.args);

  // may throw
  let result = obj[name](...args);

  return mapOutgoingObjects(result);
}

async function getterListener(payload) {
  let name = payload.name;
  assert(typeof(name) == "string", "Need property getter name");
  assert(typeof(payload.obj) == "string", "Need object ID");
  let obj = getLocalObject(payload.obj);

  // may throw
  let value = obj[name];

  return mapOutgoingObjects(value);
}

async function setterListener(payload) {
  let name = payload.name;
  assert(typeof(name) == "string", "Need property setter name");
  assert(typeof(payload.obj) == "string", "Need object ID");
  let obj = getLocalObject(payload.obj);
  let value = mapIncomingObjects(payload.value);

  // may throw
  obj[payload.name] = value;
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
  assert(className, "Could not find class name for local object");
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
  assert(obj, `Remote object with ID ${ id } is unknown here.`);
  return obj;
}

/**
 * @param id {string} ID of object refererence
 * @returns {obj} local object
 */
function getLocalObject(id) {
  let obj = gLocalIDsToObjects.get(id);
  assert(obj, `Local object with ID ${ id } is unknown here.`);
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
  let existing = gRemoteObjects.get(id);
  assert( !existing, `Remote object ID ${ id } already exists.`);
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
  assert(obj, `Remote object with ID ${ id } is unknown here.`);
  gRemoteObjects.delete(id);
}

/**
 * Remote side says that it no longer needs this object.
 * Drop the reference to it.
 * @param id {string} ID of object refererence
 */
function deleteLocalObject(id) {
  let obj = gLocalIDsToObjects.get(id);
  assert(obj, `Local object with ID ${ id } is unknown here.`);
  gLocalIDsToObjects.delete(id);
  gLocalObjectsToIDs.delete(obj);
}

var gRemoteObjectRegistry;
