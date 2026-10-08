'use strict';

// One class split over several files by concern (3.2): each part is written as a plain class body in its own file
// and its methods are copied onto the main class's prototype. `this` is the main instance as before. A method that
// two parts both define is a programming error, refused at load — never a silent override.
function mixin(Target, ...parts) {
  for (const Part of parts) {
    for (const name of Object.getOwnPropertyNames(Part.prototype)) {
      if (name === 'constructor') continue;
      if (Object.prototype.hasOwnProperty.call(Target.prototype, name)) throw new Error(`mixin: ${Target.name}.${name} is defined twice (${Part.name})`);
      Object.defineProperty(Target.prototype, name, Object.getOwnPropertyDescriptor(Part.prototype, name));
    }
  }
  return Target;
}

module.exports = { mixin };
