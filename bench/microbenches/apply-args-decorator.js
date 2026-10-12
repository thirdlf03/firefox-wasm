// YouTube kevlar's decorator helpers (kevlar_main_module line 3470):
// `fn.apply(0, arguments)` into a rest-args helper, then `Q.apply(null, arr)`.
// JIT-compiling the closure-returning wrapper broke ytd-app registration.
class Benchmark {
  setup() {
    const _ = {};
    _.T7 = function () {
      for (var Q = Number(this), Y = [], m = Q; m < arguments.length; m++) Y[m - Q] = arguments[m];
      return Y;
    };
    _.Gw = function (Q) { return Q instanceof Array ? Q : Array.from(Q); };
    const $Dh = function (Q) {
      return function () {
        var Y = _.T7.apply(0, arguments);
        return function (m, U, V) { Q.apply(null, _.Gw(Y))(m, U, V); };
      };
    };
    const ncA = function () {
      return function () {
        var Q = _.T7.apply(0, arguments);
        return function (Y, m, U) { oEi.apply(null, _.Gw(Q))(Y, m, U); };
      };
    };
    const self = this;
    const H4Y = function (a, b) { return function (m, U, V) { self.acc = (self.acc * 31 + a.length * 7 + (b ? b.length : 3) + U.length + (V | 0)) | 0; }; };
    const oEi = function (a) { return function (Y, m, U) { self.acc = (self.acc * 17 + a.length + m.length + (U | 0)) | 0; }; };
    _.w = function (Q) { return ncA()(Q); };
    _.Vi = function () { return $Dh(H4Y).apply(null, _.Gw(_.T7.apply(0, arguments))); };
    this._ = _;
    this.acc = 1;
  }
  runIteration() {
    const _ = this._;
    for (let i = 0; i < 20000; i++) {
      const name = "prop" + (i & 15);
      _.w("evt" + (i & 7))({}, name, i & 3);
      _.Vi("a" + (i & 3), "bb")({}, name, i & 5);
      _.Vi("c")({}, name, 1);
    }
  }
  result() { return this.acc | 0; }
}
