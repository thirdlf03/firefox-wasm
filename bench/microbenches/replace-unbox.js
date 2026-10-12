// String_replace fast path (0018/0020) and sunk Unbox guards (0019/0020).
// Regexps that are not one plain character class must still replace,
// Array.from(set) without a mapfn runs while the nursery churns.
class Benchmark {
  setup() {
    this.n = 4000;
    this.esc = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  }
  hash(h, s) {
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  }
  runIteration() {
    const esc = this.esc;
    let h = 7;
    for (let i = 0; i < this.n; i++) {
      const plain = "item-" + i + "-value";
      const rope = plain + " and " + (i & 255) + " more " + plain;
      const html = (i & 3) === 0 ? rope + "<b>&</b>" : rope;
      h = this.hash(h, html.replace(/[&<>"']/g, (c) => esc[c]));
      h = this.hash(h, rope.replace(/[a]|[^b]/g, "_"));
      h = this.hash(h, ("zz" + (i & 255) + "zz").replace(/[a]|[^b]/g, "_"));
      h = this.hash(h, plain.replace(/[\/\-]/g, "+"));
      h = this.hash(h, plain.replace(/[\.\"]/g, "?"));
      h = this.hash(h, rope.replace(/[xyz]/g, "#"));
      h = this.hash(h, plain.replace("-", "~"));
      const re = /[q]/g;
      re.lastIndex = 3;
      h = this.hash(h, plain.replace(re, "!")) + re.lastIndex;
      const set = new Set();
      for (let k = 0; k < 8; k++) set.add({ k: k + i, s: "v" + k });
      const arr = (i & 7) === 0 ? Array.from(set, (o) => o.k) : Array.from(set);
      for (let k = 0; k < arr.length; k++) {
        const v = arr[k];
        h = (h + (typeof v === "number" ? v : v.k + v.s.length)) | 0;
      }
    }
    this.h = h;
  }
  result() { return this.h | 0; }
}
