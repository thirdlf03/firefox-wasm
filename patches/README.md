# patches/ — engine-side patches for the JS→WASM JIT

The JS→WASM JIT itself lives in the pinned Gecko engine fork
(`HeyPuter/firefox`, fetched by `make firefox` into `firefox/`, which is
git-ignored). Any JIT work therefore lands in `firefox/js/src/wasm/WasmJit*.{h,cpp}`
and is kept here as a patch so it is versioned with this repo.

Apply after `make firefox`:

```bash
git -C firefox apply ../patches/0000-build-skip-spidermonkey-style-checks.patch
git -C firefox apply ../patches/0001-wasmjit-lowering-improvements.patch
```

**The full engine build applies (and verifies) these automatically** — apply them by hand
only for the JS-only dev loop, which uses `make firefox` + `mach` directly and never runs
`make build`. `make build` / `make configure` depend on `.wj-patched`
(the `$(PATCH_STAMP)` target in the Makefile), which:

1. applies each `patches/*.patch` in file-name order, skipping any that is already
   applied (so a dev tree with WIP edits is never clobbered);
2. then **verifies** the tree is exactly `pinned revision + patches` (every patch
   reverse-applies). If it is not, make **fails** instead of building — because a release
   built without these patches ships the fork's baseline JIT, which measured *identical*
   to the pre-JIT upstream release (`v0.0.1`) and bails on every op that `0001` lowers
   (6 bail sites -> 0, 1.59x on the object/class/accessor family).

Escape hatches: `FORCE_PATCH=1` resets `firefox/` to the pin and re-applies cleanly;
`PATCH_STRICT=0` downgrades the verification failure to a warning (dev tree with WIP
edits). When the patch list or the application logic changes, bump the `patches1` salt in
the CI engine-cache key — hashing `patches/**` cannot distinguish an objdir built with the
patches from one built without.

## 0000-build-skip-spidermonkey-style-checks.patch

Makes `config/run_spidermonkey_checks.py` a no-op when `WJ_SKIP_STYLE_CHECKS=1`.
`--enable-project=js` implies `JS_STANDALONE`, so the standalone SpiderMonkey
style checker runs as part of `mach build`; the fork's added files
(`WasmJit*.cpp`, `WasmInterp.h`) have include-ordering violations that make the
check fail and abort the build. The env gate lets the JS-only dev build proceed
without touching the fork's style. Never affects a production build (the variable
is unset by default).

## 0001-wasmjit-lowering-improvements.patch

Backend/helper lowering work in `WasmJitBackend.{h,cpp}` + `WasmJitRuntime.cpp`.
Each item below was found by `GECKO_WJ_LOGBAIL=1` (whole functions silently
staying in PBL) and is gated by a new microbench where possible.

### 1. Date op family (bailed every Date-using function)

`Date.now()`, `Date.parse()`, `new Date(ms)` and the Date getters used to bail
the containing function. New `wjhelp` kinds + backend lowering:
`MDateNow`, `MDateParse`, `MTimeClip`, `MNewDateObject`,
`MDateFillLocalTimeSlots`, `MDate{Hours,Minutes,Seconds}FromSecondsIntoYear`,
`M{Year,Month,Date}FromTime`, `MLocalTimeToUTC` (Int64 operand staged in the
untraced `gWJHelpI64`). Plus two general gaps the work surfaced: `MConstant` of
`Int64` and of the magic types, and `EmitBoxFromStack(Float32)`.

`micro date-ops`: jit 24.6 ms → 18.0 ms (~1.37×), `bails: -` (was 4 distinct).

### 2. Mixed Int32/Double arithmetic produced INVALID wasm

Warp's `emitDoubleBinaryArithResult` builds `MAdd/MSub/MMul/MDiv(lhs, rhs,
Double)` from `NumberOperandId`s whose defs can be **Int32 phis** (no
`MToDouble`). The backend emitted `f64.add`/`f64.div` straight onto the i32
local; V8 rejects the whole module (`f64.add expected f64, found local.get
i32`) and the function silently stays in PBL (`host-compile-reject`, which
`--bails` does not even report). An Int32-repr operand is now converted with
`f64.convert_i32_s`; i64/Value operands still bail cleanly.

`micro mixed-arith`: jit 43.5 ms → 1.7 ms (~25×), identical checksum.
`micro string-ops` also stops bailing.

### 3. Other missing/invalid lowerings

* **`MGuardHasAttachedArrayBuffer`** — inline port of
  `MacroAssembler::branchIfHasDetachedArrayBuffer` (shared-memory elements,
  non-object buffer slot, then the ArrayBuffer `DETACHED` flag → deopt).
* **`MToIntegerIndex`** — relative-index normalization (`(i<0) ? max(0,i+len) :
  min(i,len)`) for `subarray`/`copyWithin`/`fill`.
* **`MMinMax`** — add the `IntPtr`/`Float32` cases (IntPtr uses the same
  compare+`select` as Int32; Float32 is held as f64) and repr-guard the
  Double path. The old Int32 `select` sequence pushed only one value on the
  stack in some shapes → invalid wasm.
* **IntPtr `MAdd`/`MSub`/`MMul`** — plain i32 ops with no overflow snapshot
  (matching Ion's `LAddIntPtr`/`LSubIntPtr`/`LMulIntPtr`).
* **`MTypedArraySubarray`** — implemented (`js::TypedArraySubarrayWithLength`)
  but **staged OFF by default** (`GECKO_WJ_TASUB=1` enables it): compiling
  pdf.js's `FlateStream_readBlock`, which needs it, miscompiles (wrong value /
  OOB). That is a latent bug in that large function exposed by compiling it, not
  in this op (the `typed-subarray` probe passes with the op enabled). With the
  default bail the function stays in PBL, which is correct.

`micro minmax-idx` covers Math.min/max over indices + IntPtr index arithmetic.

### 4. Conversions, small guards, `Object.is`, `Math.atan2`, typed-array offset

More whole-function bails found by `GECKO_WJ_LOGBAIL` on a probe that uses them
(`micro samevalue-atan2`: 1.02× → 9.23×):

* `MIntPtrToDouble`, `MIntPtrToInt64`, `MInt64ToIntPtr`, `MExtendInt32ToInt64`,
  `MWrapInt64ToInt32` — pointer/int64 conversions (wasm i32/i64 ops).
* `MSameValueDouble` — `a == b || (a != a && b != b)` (Object.is on numbers).
* `MSameValue` — `js::SameValue` helper (Object.is on values).
* `MAtan2` — `js::ecmaAtan2` helper (Math.atan2).
* `MNegativeToUndefined`, `MLoadValueTag`, `MIdToStringOrSymbol` (passthrough).
* `MGuardIntPtrIsNonNegative`, `MGuardInt32Range`, `MGuardIsExtensible`
  (deopt on miss, passthrough on hit).
* `MArrayBufferViewByteOffset` — inline `byteOffset` PrivateValue slot read.
* `MNop`, `MAssertFloat32`, `MAssertCanElidePostWriteBarrier` — no-ops.

### 5. `Math.hypot`/`Math.sign`, object-literal accessors, typed-array resizability

Found by a broad kitchen-sink probe (`micro kitchen-sink`, 10 feature groups):
`MHypot` (2-4 args -> `ecmaHypot`/`hypot3`/`hypot4`), `MInitPropGetterSetter` /
`MInitElemGetterSetter` (object-literal `get x(){}` -> the VM operations, name
atom interned in the traced pool), `MGuardIsResizableTypedArray` /
`MGuardIsNonResizableTypedArray` (class-range check), and `MSign` (all four
Int32/Double combinations, incl. the NaN bailout for Double->Int32).

### 6. Class/object-definition and spread ops

Second kitchen-sink probe (`micro kitchen-sink2`: generators, prototypes, classes,
symbols, BigInt, arguments/spread/rest/destructuring, switch/labels, errors/Proxy,
JSON): `MObjectWithProto` (`Object.create`/`__proto__`),
`MNewClassBodyEnvironmentObject`, `MMinMaxArray` (`Math.max/min(...arr)`,
dense-number fast path with a deopt flag), `MNewPrivateName` (`#priv`),
`MFunctionWithProto`, `MInitHomeObject`, `MCheckClassHeritage`.

Generators still bail (`entry-alwaysBails`); async/Promise and a couple of string
methods are unsupported by the minimal embed itself (fail in PBL too).

### 7. Array/string/math/typed-array/DataView/Reflect probe

Third probe (`micro kitchen-sink3`): `MIsTypedArrayConstructor` (pure class
check) and `MGuardFuse` (deopt if the realm fuse popped; looked up by index in
the runtime, no per-script dependency registration). Everything else in the
probe (Array/String/Math/Date/TypedArray/DataView/Reflect/Object methods, tagged
templates) already compiled. `new.target` (`MNewTarget`) still bails: the JIT
entry does not plumb new.target, so it is left to PBL. `localeCompare` traps in
the minimal embed itself (intl disabled).

### 8. Inferred function names

Fourth probe (`micro kitchen-sink4`: Symbol.toPrimitive, prototype accessors,
custom iterators, Symbol.hasInstance/toStringTag, spread/apply/Reflect.apply,
ES2023 array methods, named-group regexps, optional chaining/nullish): only
`MSetFunName` bailed -> `js::SetFunctionName` helper (inferred `f.name` for
arrow/method definitions).

### 9. kWJMaxArgs 8 -> 16

Functions with more than 8 actual args stayed in PBL (`too-many-args`), and an
arg-count-related `Call` bail also disappeared. octane earley (9-arg
`deriv_trees`): 6.7x -> 9.0x, no bails. The cost is 8 extra wasm params per JIT
call: interleaved A/B shows octane deltablue ~2% slower (7.44 -> 7.15 ratio) and
richards/splay neutral. Net clearly positive.

### 10. Realistic site workload (thirdlf03.com + real libraries)

`bench/site/` runs parse5 / htmlparser2+css-select / a hand-written search index /
preact-render-to-string / lodash over the real page content. It found:

* `MMapObjectSize` / `MSetObjectSize` (+ the whole Map/Set get/has/set/delete/add
  group) via the `js::jit::MapObject*` / `SetObject*` VM helpers.
* `MObjectState` / `MArrayState` — Ion's recover-only literal summaries (Ion
  never lowers them). A passthrough of the summarized object/array. This was
  blocking compilation of *large* functions that build object/array literals
  (preact's 5.7 KB `renderToString`).
* **for-in loop-head deopt-resume**: the bail was also firing for an *exception
  exit* inside a try region (`EmitExceptionExit` -> `EmitDeoptResume`), where the
  resume is in error mode and PBL `goto error` -> `HandleException` (it does NOT
  re-run `MoreIter`). Skipping the bail for error resumes is sound and unblocks
  such functions. The genuine guard-miss case (a GuardShape deopt at a for-in
  LoopHead, e.g. acorn) still bails.

With `GECKO_WJ_MAXLEN=8192` the preact SSR bench goes 90 ms -> 50 ms (1.80x,
identical checksum). The 4096 default is kept: raising it regresses octane
(richards 7975 -> 6358) and ubo (999 -> 1132 ms) because their large functions
are net-negative to compile.

### 11. Native-call fast path (`WJH_CALLNATIVE`)

The SPA spends ~2.6M calls/run in `wjhelp(WJH_CALL)` -> `JS::Call` for
non-inlined natives (regexp helpers, `Array.prototype.sort`, `String`,
Map/Set ops, `Math.round`, `toFixed`). Two-level fix, both funneling into a
shared `WJNativeCall` that replicates `CallJSNative` semantics
(recursion-limit RAII, `DebugAPI::onNativeCall`, `AutoRealm`, global-`this`
outerization, `NativeResumeMode::Override`):

* `WJH_CALL` probes the boxed callee for `JSFunction` + `isNativeFun` and
  calls `fun->native()` directly, skipping `InvokeArgs`/`JS::Call`.
* `MCall` on a constant native callee emits `WJH_CALLNATIVE` with
  `vp=[callee,this,args]` staged at scratch[0..argc+1] and
  `(argc<<32)|nativeFnPtr` packed into the site f64. A stale baked identity
  degrades back to generic `WJH_CALL`.

Reentrancy safety: the `vp` lives in a per-call `JS::RootedValueArray<62>`
on the C++ stack, NOT `gWJScratch` — natives re-enter JS (sort comparators,
getters) whose own helper staging would otherwise clobber the outer call's
args. `fun` is re-derived from rooted `vp[0]` after `onNativeCall` (debug JS
can GC/move the callee).

Interleaved A/B medians: `micro native-call` 118 -> 80 ms (+33%), spa.js
85 -> 78 ms (+8%), site search +23%, octane regexp +23%. `GECKO_WJ_NONATIVECALL`
/ `GECKO_WJ_NONATIVEBE` disable each level. `[wb-calls]` gains `native=`.

## 0002-wasmjit-cohort-and-pbl-work.patch

Delta between `pin + 0000 + 0001` and the current engine work tree. Two bodies of
work, plus supporting files that were previously uncommitted.

### A. WasmJit "cohort" module fusion (Hotpack)

Baseline WJ topology is 1 JIT function = 1 wasm module = 1 instance, so every
JIT->JIT call goes through a `call_indirect` on the shared table into a *foreign*
instance, which V8 cannot speculatively inline. A standalone probe
(`browser-in-browser/verify/cohort-probe.mjs`) measured same-instance
`call_indirect` at 2.4-2.7x faster than cross-instance in Chrome for small
callees.

`GECKO_WJ_COHORT=N` (off by default) batches up to N compiled functions into one
module/instance:

- Solo compile caches the emitted body bytes in `WJEntry::jitBody`; cohort
  assembly (`WJWarpCompileCohort` -> `AssembleBodiesAndInstall`) is a pure byte
  copy into a shared module - no second Warp/MIR run.
- Call-IC fill records observed caller->callee edges (`gWJCallEdges`); drain
  packs edge endpoints first, expands transitively. Packing is edge-only by
  default (`GECKO_WJ_COHORTPAD=1` restores padding with unrelated pending
  seeds) -- on real site workloads padding packed ~all compiled functions and
  regressed 1.1-1.6x at cap16.
- Members keep their existing shared-table slots (caller IC caches stay valid);
  trampolines are exported as `f`/`f1..`, register-ABI bodies as `m`/`m1..`;
  host dispatch selects the member via `wasmhost_call(handle, memberIdx)`.
- Constructor cache entries are repointed handle+member on cohort install;
  invalidate-all clears jitBody/pending/edges; all script pointers are
  GC-traced in `WJTraceRoots`.
- `wasmhost_jit_table_set(handle, slot, member)` gains a member arg (both
  `gecko.js/lib/` and `bench/spidermonkey.js/` bridges updated).
- Drain fires on pending>=cap, on the `WasmJitDrainDeferred` idle boundary, and
  on IC-fill edge recording when pending>=min(8,cap).
- stats: `cohorts` / `cohortMembers` / `cohortEdgePulls`; `GECKO_WJ_COHORTDBG=1`
  traces installs.

Measured (embed shell, interleaved runs, noisy machine): `micro call-chain`
(16-callee chain) ~15-30% faster at cap>=17; octane/micro results identical
(all sums match); jit-test basic+osr ~1500 tests: failure set identical to
solo (all pre-existing minimal-embed shell gaps, zero cohort regressions).

### B. PBL weval/wizer plumbing (previous session work, unpatch till now)

- `--enable-pbl-weval` configure option + `ENABLE_JS_PBL_WEVAL` (default off);
  `js/src/vm/Weval.h`, `PortableBaselineInterpret-{defs,weval-defs}.h`,
  `third_party/weval`, `third_party/wizer` vendored headers.
- `js/src/shell/wizer.cpp` (Wizer preinit entry for the js shell) - compiled
  unconditionally, the weval bits are config-gated.
- `PortableBaselineInterpret.cpp` interpreter work the above builds on;
  `JSScript.{h,cpp}` + `CacheIRCompiler.*` + `BaselineCacheIRCompiler.cpp`
  supporting changes.
- `mozglue` small fixes (xxhash/SSE/PerfStats build fixes for the wasm target).

### C. Type-storm generic-compare recompile (deopt storm fix)

Lodash `compareAscending` (sort comparator, mixed number/string args)
specialized `value > other` to `Compare_String`; its operand Unbox
tag-guards deopted on ~46% of calls (~1.1M deopts measured).

- `shapeDeoptDom` is now a true majority (shape-family sites > 50% of the
  fn's deopt sites) -- an incidental `GuardSpecificFunction` (lodash's
  `isSymbol`) no longer blocks the count-gate recompile of an
  Unbox-dominated fn. `GuardGlobalGeneration` sites moved to their own
  counter (`hasGggDeopts`) and remain an ABSOLUTE count-gate block
  (respec re-bakes stale globals: the acorn misparse hazard).
- A count-gate storm that survives its fresh recompile gets one extra
  attempt with `e.forceGenericCmp`: fallible MUnboxes consumed only by
  genericable compares drop their tag guards (their typed locals are dead);
  numeric compares emit "both-number -> inline f64 cmp, else WJH_COMPARE";
  String/Symbol/BigInt compares stage the unbox INPUTS into WJH_COMPARE
  with no refinement guards. Cannot deopt; correct for all type pairs.
- `GECKO_WJ_GENERICCMP=1` forces the mode for testing.

Measured (embed, wiki:lodash A/B, NORECOMPILEN=1 as pre-fix): perIter
319.2 -> 303.5ms, deopts @2056 unbounded -> 3000 total then 0.
A storm-threshold PBL fallback alternative was measured ~10% SLOWER and
rejected.

### D. GSF call-guard attribution + genericCall recompile

css-select `combine` closures (dom.js:4181, `a(elem) || b(elem)` over
per-instance upvalue callees) stormed ~200k GuardSpecificFunction deopts/run
that were INVISIBLE to the valve: the deopts happen inside JIT->JIT fast
calls (PIC call_indirect / WJH_CALL's direct wasm call), so no host entry
runs and `e.deopts` stayed ~0 (entry showed 2 while site-hist saw 199k).

- WJH_RESUME attributes GSF deopts to the deopting module's own entry
  (`gWJResumeScriptPtr[nframes-1]`, `WJEntry::gsfDeopts`). Past
  `GECKO_WJ_GSFGATE` (default 1500) -> Cold + `forceGenericCall`; a second
  storm -> Failed (PBL). `GECKO_WJ_NOGSFVALVE` reverts; `GECKO_WJ_GENCALL=1`
  forces the flag for testing.
- Under `be.forceGenericCall`, a GSF whose uses are all call callees (the
  GuardFunctionScript `allCallCallee` precedent) becomes a passthrough --
  the PIC already dispatches polymorphically; a non-callee use (inlined
  region / identity consumer) keeps the guard.
- Measured: synthetic 8-closure repro 7463 -> 972ms (7.7x, SINK identical,
  sitehist silent); wiki:dom 3803 -> 2135ms/iter (1.78x, MICROSUM OK);
  micro --ab all OK; octane deltablue/richards/splay healthy.

## 0003-wasmjit-storm-and-callback-fixes.patch

Delta between `pin + 0000 + 0001 + 0002` and the work tree: the site-workload
deopt-storm fixes and the remaining megamorphic/inline-cache work (see
artifacts/results.md for full measurements; wiki:lodash ~336 -> ~230ms,
wiki:dom ~1020 -> ~971ms, all MICROSUM-verified).

### A. Deopt-storm attribution + PIC invalidation

- Contained (JIT->JIT callee) deopts were charged to the CALLER entry:
  callers of lodash's `compareAscending` stormed -> Failed -> 482k calls/run
  stayed PBL forever (~28% of profile). Deopts are now attributed to the
  outermost resume frame's script (`gWJResumeScriptPtr[nframes-1]`), and the
  storm decision runs on that entry.
- `WJPurgeCallICs(e)` on every Cold/Failed transition (storm valve AND gsf
  valve -- its absence there let stale PIC ways drive a hidden 27.5k-event
  GuardSpecificFunction storm on wiki:dom). Without the purge, callers keep
  invoking the dead module forever.
- Result: lodash deopts 4200 -> 300, failed 2 -> 0, perIter ~336 -> ~274ms.

### B. Native->JS RunScript observation hook + interpreter-only gate

- `js::RunScript` observes interpreted callees and routes them through
  `WasmJitRunCall` once compiled -- native callbacks (array_sort comparator)
  no longer stay PBL forever. `GECKO_WJ_NONATIVEOBS=1` disables.
- `WasmJitObserveCall`/`WasmJitPreCall` now reject `hasForceInterpreterOp()`,
  `isGenerator()`, `isAsync()` scripts: WJ-compiling self-hosted
  `InterpretGeneratorResume` caused infinite wasm<->host recursion
  (V8 stack overflow) via its JSOp::Resume -> jit::InterpretResume ->
  CallSelfHostedFunction -> hook loop.

### C. Megamorphic probes + inline cache work

- Store-side `EmitByValMegaStoreProbe`: dense in-bounds writes, SetPropCache
  atom-key hits, add-prop (newCapacity==0, no incremental marking), array
  extension append; site5 fills via `SetElementMegamorphic<true>`.
  SETPROP helpers 2.4M -> ~100k/run.
- Nursery bump-alloc for WJH_NEWCALLOBJ + WJH_LAMBDA (3.1M -> 253, 1.7M -> 88).
- Bounded (K=8) string-equality inline compare: COMPARE helpers 8M -> ~1.
- Script-keyed call IC + wasm-side fun_call unwrap: closures sharing a
  JSScript hit the same PIC way (megamorphic iteratee sites 0 hits ->
  ~1-2M hits/run); lodash ~2.4x, wiki:dom ~1.3x on top of prior work.
- WJTryNativeFast: Set/Map iterator intrinsics inline via jitInfo().

### D. Misc

- V8 `--perf-basic-prof` names wasm by function index (ignores the name
  section) -- the experimented name-section emit was reverted.
- gczeal=2/7/11 MICROSUM-consistent; the earlier zeal=14 storm-recompile
  crash no longer reproduces after the PIC purge.

### E. wj-nobs debug-map dangling JSScript* (browser crash fix)

The RunScript-hook debug map (`[wj-nobs]`, active unless GECKO_WJ_NOBSDBG)
kept raw JSScript* keys and dereferenced them (`filename()`/`lineno()`) in
the every-500k-calls fprintf. Scripts are GC'd between evals, so on
multi-workload pages (site suite running search+dom+lodash in one engine)
the print walked freed memory -> "memory access out of bounds" trap in
BOTH arms (PBL arm included: hooks still run, entries just never compile).
Reproduced on the v0.0.6 release gecko.js; absent with GECKO_WJ_NOBSDBG=1.
Fix: resolve filename/line/name eagerly at insertion; the print reads only
the stored string. (Also explains the earlier embed sighting of the same
trap shape.)

## 0004-wasmjit-vibey-shape-fold.patch

Delta between `pin + 0000 + 0001 + 0002 + 0003` and the work tree: the
vibey-clover (three.js game bundle) deopt-storm fixes. All verified on the
site bench suite (bench/site, `run.sh vibey`/`wiki`); every vibey workload
now beats PBL (vibeyboot 0.37x -> 1.31x, jsparse 1.28x, frame3d 9.4x).

### A. Unsigned-right-shift result typing (mulberry32/LCG PRNG storm)

`x >>> 0` (or any shift whose count can be 0 mod 32) can produce a bit31-set
result whose true JS value is a Double, but MIR typed MUrsh Int32 and the
deopt->resume path never updates the IC -- so the function deopted on ~every
call forever (three.js's PRNG runs every frame). Post-OptimizeMIR MIR pass
flips such MUrsh to Double (dblUrsh path: i32.shr_u -> f64.convert_i32_u)
and wraps non-Int32 bitop operands in MTruncateToInt32 (Ion lowers these at
the LIR operand-policy layer, which WJ does not have).

### B. Proxy ops (GuardIsProxy / GuardIsNotDOMProxy / ProxyGet / ProxySet)

GuardIsProxy: inline clasp->JSCLASS_IS_PROXY check. GuardIsNotDOMProxy:
ProxyData handler -> BaseProxyHandler::mFamily vs baked
GetDOMProxyHandlerFamily(). MProxyGet[ByValue] -> WJH helpers calling
js::ProxyGetProperty[ByValue]; MProxySet[ByValue] likewise (site bit0 =
strict). vibeyboot now compiles clean: failed=0, zero unsupported ops.

### C. Compile-time cold stub folding (acorn Parser lazy-prop storm)

Acorn's Parser adds `inTemplateElement` lazily mid-parse (one-way shape
transition S3->S4). Compiled methods bake whichever shape is firstStub, but
the IC's older stub keeps enteredCount=0 after the attach reset, so
TryFoldingStubs (numActive==0 gate) never folds and the transpiler bakes a
single shape -> perpetual oscillating storm as each parse() creates a fresh
S3 parser. `TryFoldingStubs{,Locked}` gains a `foldCold` flag (default off);
maybeInlineIC passes true (GECKO_WJ_NOCOLDFOLD kills). Folds zero-entered
stubs whose chain differs only in a WeakShape field -> GuardMultipleShapes
-> MGuardShapeList (already lowered). Coverage superset, always safe.

### D. Diagnostics (all env-gated)

GECKO_WJ_ICDBG2=<line>: per-stub dump at compile time (stub shapes + last
prop key). GECKO_WJ_GSRT/THISDBG/GSDUMP: expected-vs-actual shape on
GuardShape deopts; guarded-operand MIR op + expected-shape keys at emit.

Measured: vibey:jsparse 11787 -> ~5250ms/iter (fold; ~2.2x, PBL 9-10s);
vibeyboot 8406 -> ~350-675ms/iter vs PBL ~340-880. MICROSUM/JSSCORE
identical; micro suite + wiki trio no regressions.

## 0005-wasmjit-depth-limit-calibration.patch

JIT'd JS recursion killed the engine on x.com: gWJJitDepth's guard existed but
its 2.5MB byte limit was baked ABOVE V8's real ~1MB wasm call stack, so deep
recursion hit the host's uncatchable RangeError (`wasm-function[1]` self-call
loop) instead of the catchable ReportOverRecursed throw, killing the app
pthread outright (probe: JIT f(3000) dead; PBL f(500000) throws InternalError
and survives).

- gWJJitDepthLimit becomes a runtime-mutable global (default 480000 -> <=600
  frames of any guarded fn even uncalibrated). EmitDepthCheck loads it per
  entry instead of baking the const; GECKO_WJ_DEPTHLIMIT still bakes an
  override and disables calibration.
- Per-frame charge gets a floor: fb = max(frameBytesEst, 800). The estimate
  misses operand-stack slots, so real V8 Liftoff frames run ~700B+ even for
  tiny fns; without the floor thin fns under-charge and the guard fires late.
- wj_set_depth_limit export; wasm-host-bridge probes the real host stack once
  per worker realm at first wasmhost_instantiate: a wasm fn with a fat frame
  (96 f64 locals, ~860B real > thin JIT frames) recurses until the host
  RangeErrors, then sets limit = depth * 800 * 0.6 clamped [200000, 2800000].

## 0006-windowless-window-provider.patch

`WebBrowserChrome2Stub` gains `nsIWindowProvider`: `_blank` links and
`window.open` in the windowless browser hit `nsIWindowWatcher` with no
provider and no `mWindowCreator` -> `NS_ERROR_FAILURE` before the
`browser.link.open_newwindow` pref is ever consulted. The provider returns
the browser's own docshell with `aWindowIsNew=false`, so the load lands in
the current window (no opener assertion, no resize path). Combined with
`browser.link.open_newwindow=1` + `browser.link.open_newwindow.restriction=0`
in embed-init prefs.

## 0007-wasmjit-depth-suspend.patch

Fixes two recursion-guard bugs and turns depth overflow into a delegated
PBL subtree instead of a throw.

- **Placement bug (the real x.com crasher)**: EmitDepthCheck was invoked in
  EmitBlockBody "at the first block", but the dispatch-loop emitter walks
  MIR blocks in REVERSE RPO (`bi = n-1-ri`), so the guard landed in a
  terminal return pad and never ran on entry. Verified: `DEPTHLIMIT=0`
  still recursed to the host stack limit inside `wasm-function[1]`.
  EmitDepthCheck now runs in the straight-line PROLOGUE (after the GGG/argc
  entry checks, before the env-root push), covering single-block, relooper
  and dispatch bodies plus the OSR trampoline re-entry. The refusal arms no
  longer pop env roots (nothing is pushed yet at that point).
- **Suspend latch**: overflow no longer throws or returns flag 2.0 (GGG
  accounting would misfire). It restores gWJJitDepth, min-updates
  `gWJSuspendWatermark`, and returns a dedicated flag 3.0. Every JS->WJ edge
  (PreCall, ObserveCall, RunCall, WJH_CALL fast path, OSR resume, ctor
  caches) refuses while `gWJJitDepth >= watermark`, so the delegated subtree
  runs entirely in PBL; the latch self-clears when the delegating wasm
  frames unwind (EmitDepthPop drops below the watermark) and RunCall clears
  it at depth 0. Callsite flag compares became `flag < 2.0` so 2 and 3 both
  take the slow path; flag 3 never increments gggDeopts.
- `GECKO_WJ_DEPTHLIMIT` now tests env PRESENCE (0 previously fell back to
  the default, masking refusal paths in tests). `GECKO_WJ_DEPTHTHROW` keeps
  the old throw mode. New env-gated diagnostic helper kind 253
  (`GECKO_WJ_SUSDBG`, prints refusals); kind 250 was already WJH_TRACE's.

Verified locally (embed build): try/finally self-recursion and plain
recursion both delegate and complete (fin(2600), f(3000)-4500); truly
excessive recursion throws catchable InternalError (PBL quota) and the
process survives. Octane richards 4092 vs 4254 unguarded (~4% worst-case
entry cost); earley/splay/deltablue unchanged-correct.

## 0008-wasmjit-fresh-script-family.patch

Same-source fresh scripts (every `new Function("x","return x*2+1")` call
makes a new JSScript) used to each pay the full warmup + compile cost --
or never compiled at all, when each clone died before the per-script
threshold. SM already dedups bytecode+atoms into a shared
`SharedImmutableScriptData` (verified: 50 clones -> identical sd pointer),
so that sd is a zero-cost family key. One shared compile now serves the
whole family.

### A. Family records (WasmJitRuntime.cpp)

- `gFamilies`: `SharedImmutableScriptData* -> WJFamily`, realm-confined
  (baked GGG/global cells are realm-specific). The sd key is AddRef'd --
  `SweepScriptDataTable` frees interned data with no live scripts, and the
  family record is long-lived.
- `WasmJitFamilyObserve(script)` counts aggregate cold calls; at
  `GECKO_WJ_FAMWARM` (default 64) it arms `compilePending` and the caller
  routes through the normal ObserveCall path. `refCount() >= 3` gate keeps
  one-off interned-but-never-cloned scripts out of the map.
- The next eligible member (has jitScript -- Warp needs BaselineIC
  feedback; not eval/module/generator/async) gets the shared compile
  (`gWJSharedCompile`); on success the artifact metadata (handle, tblSlot,
  directIdx, jitBody, osrTargets, ...) publishes onto the family and the
  representative entry links to it.
- Later siblings alias-install (`WJAliasInstall`) instead of compiling --
  creating their jitScript first, since a deopt resume requires it and the
  alias path skips the compile that would have made it.

### B. Member compatibility (the load-bearing check)

gcthings live in per-script `PrivateScriptData`, NOT in the shared sd --
each clone measured its own body-Scope cell. The shared artifact bakes the
representative's cells, so a member may run it iff every gcthing actually
REFERENCED by a bytecode immediate is pointer-identical:
`WJMemberCompatible` scans the representative's bytecode for JOF_GCTHING /
OBJECT / REGEXP / SCOPE / BIGINT / STRING / SHAPE / ATOM ops (all read
GCThingIndex at pc+1; atoms share cells realm-wide so they pass naturally)
and compares `GCCellPtr::asCell()`. Unreferenced slots (the outermost
scope every function carries) may differ. Verified: lambda/object-template
clones correctly FAIL (`gcmp FAIL kind=0`, per-clone template cells) and
fall back to per-script compile; the inner same-source lambdas form their
own compatible family.

### C. Runtime-bound resume (WasmJitBackend)

The artifact can no longer bake `info.script()` into
`gWJResumeScriptPtr[outermost]` -- an alias must resume its OWN script.
In shared mode the emit loads it at runtime: `gWJCallRoots[envRootIdx+1]`
(the rooted runtime callee) -> `JSFunction::offsetOfJitInfoOrScript`.
Shared compiles force `usesCallee`/`useEnvRoot` and bail on inlined
frames (`shared-inline`) -- inline frames would bake the representative's
callee scripts. pcOff/nargs/nlocals stay baked: the bytecode is identical
across the family.

### D. Call-edge coverage + lifecycle

- FamilyObserve runs BEFORE the per-script warmup gates on all four call
  edges: PBL fast path (pre-jitScript block and the warmUpCount>=10 gate),
  the direct `Interpret` Call-op dispatch (which bypasses RunScript), and
  the RunScript invoke path (native->JS callbacks).
- The rep script is rooted in `WJTraceRoots` (it owns both the
  member-compat reference cells and every baked gcthing).
- `WJStormDecision` detaches aliases (fresh tblSlot, charge family deopts)
  only INSIDE the transition -- detach-before-check previously left a
  Compiled entry with tblSlot=-1 on the below-threshold return. Family
  artifacts accumulate deopts across members; >=1000 fails the family so
  no NEW sibling aliases (existing aliases keep their own valves).
- Shared artifacts are excluded from cohort fusion (fusion rewrites
  tblSlot; sibling aliases would keep the stale slot).
- `WasmJitInvalidateAll` resets Compiled families to Warming (rep/slots/
  counters cleared) and unlinks `entry.family` everywhere.

`GECKO_WJ_NOFAMILY=1` disables; `GECKO_WJ_FAMDBG`/`GECKO_WJ_SDDBG` trace.

Measured (embed shell): 50-clone `new Function` bench does ONE shared
compile + 49 alias installs (~52 compiles -> 3 total in the run),
acc=72000000 correct. 200-clone perf probe: family ~288ms vs per-script
WJ (NOFAMILY) ~500ms vs PBL-only ~670ms. Deopt through an alias on a
changed arg type resumes the member's own script (fresh str/num correct).
Env/global reads, deep-recursion suspend delegation, and invalidate-all
all verified. Octane + realapp suites: no family ever activates there (no
refCount>=3 sd), results unchanged. jit-test function/eval/arguments
subset: 36 failures, ALL identical with GECKO_WJ_NOFAMILY=1 (pre-existing
embed gaps -- no decompileFunction/drainJobQueue/Debugger/module loader).

## 0009-wasmjit-pbl-deeper-stack.patch

x.com verification of the 0007 suspend latch showed delegation WORKS
(`[wj-sus]` fires, watermark latches, engine survives -- the old failure was
an uncatchable V8 RangeError killing the app pthread) but the delegated
sentry-filter recursion then hits PBL's own quota and the React onboarding
still doesn't mount. Root cause of that quota: `PortableBaselineStack` is a
fixed 512KB heap region; each delegated frame costs ~120B of StackVal, so a
delegated subtree dies at ~4359 frames even though PBL frames are heap, not
native stack.

- `DEFAULT_SIZE` 512KB -> 4MB. Measured (embed, NOWASMJIT): plain-recursion
  quota 4359 -> 34943 frames; host-boundary recursion (nested
  `Array.prototype.map` callbacks) 1167 -> 9359 levels -- the shadow stack is
  per-runtime shared, so nested PBL entries accumulate on it too.
- `GECKO_PBL_STACKKB=<kb>` overrides the size at JSRuntime init for tests
  (512 -> 4359 frames, 8192 -> 69895; linear).
- WJ path verified end-to-end: suspend watermark delegates at the depth cap
  and the PBL subtree now completes 20000-deep recursion (was ~4300).
  Over-quota still throws catchable InternalError; family tests all pass.

Cost: js_calloc commits the 4MB inside wasm linear memory per JSRuntime --
bounded and trivial next to the engine heap.

## 0010-emscripten-native-stack-quota.patch

x.com verification after 0007+0009 showed suspend delegation works and the
PBL shadow stack is no longer the wall, but `sentry-filter` still dies with a
catchable `InternalError: too much recursion` before React mounts. Root cause:
`XPCJSContext::Initialize` falls into the catch-all quota branch because
`canonical_os` for wasm targets is `EMSCRIPTEN`, not `XP_LINUX`. That sets
`kUncappedStackQuota = kDefaultStackQuota` = 512KB on wasm32, so untrusted
content JS gets only ~452KB of the 64MB linear-memory stack -- measured
~9469 host-boundary recursion levels before the quota error. The pref cap
(2MB) cannot help since it only lowers the quota.

- New `#elif defined(__EMSCRIPTEN__)` branch derives the uncapped quota from
  the real region: `(emscripten_stack_get_base - emscripten_stack_get_end)/2`
  (32MB with `STACK_SIZE=64MB`), floored at `kDefaultStackQuota`.
  `GECKO_NATIVE_QUOTAMB=<mb>` overrides at runtime.
- `kTrustedScriptBuffer` = 1MB so untrusted script keeps ~31MB.
- `kStackQuota`: the 2MB web-compat cap assumes 1-8MB native stacks; on
  emscripten it becomes `max(uncapped, cap)` so the pref can only raise the
  quota, never squeeze it below the derived value.
- `StaticPrefList.yaml` is NOT conditional on `EMSCRIPTEN` (the define never
  reaches `ALLDEFINES`); the cap handling lives in C++ instead.

Expected effect: untrusted recursion budget ~452KB -> ~31MB (~60x), i.e.
~620k host-boundary levels. Still catchable: quota < real stack, so
over-quota throws `InternalError` before a real wasm stack overflow.

## 0011-interp-nest-depth-guard.patch

With the 0010 quota raise, x.com's delegated recursion escaped SpiderMonkey's
catchable bound and instead overflowed V8's REAL stack (the host-side wasm
call stack): `Uncaught RangeError: Maximum call stack size exceeded` kills the
app pthread -- strictly worse than the 452KB-quota InternalError. Measured:
nested `RunScript` activations are the actual host-stack consumer (each host
boundary = one more live wasm call chain); a map-callback chain survives
>120k entries, so V8's bound is far above the ~9.5k the old quota allowed.
Nothing bounded the nesting itself.

- `RunScript` entry now counts live interpreter activations
  (`gNestDepth`, RAII-decremented). Covers Interpret + PBL + WJ-delegated
  entries uniformly -- each is one wasm-call-chain segment.
- `GECKO_NESTDBG` prints `[nest] depth=N` every 2048 crossings to measure a
  site's true crash depth.
- `GECKO_NESTMAX=<n>` (default 0 = off for now) throws a catchable
  InternalError at the cap. Once a site's real V8 bound is known, a nonzero
  default can keep over-recursion catchable instead of pthread-fatal.

## 0012-wasmjit-host-boundary-charge.patch

x.com's root-landing crash turned out to be a second recursion class the WJ
prologue byte-guard never sees: `WJ fn -> wjhelp -> host wasm -> WJ fn`
crossing cycles that re-enter compiled code WITHOUT passing a WJ prologue
(`[wj-sus]` never fires, `GECKO_WJ_DEPTHLIMIT` has no effect). The host
stack is still consumed per crossing, so the chain dies with the same
uncatchable V8 RangeError.

- `WJChargeHostBoundary(kind)` charges each crossing to a DEDICATED
  host-boundary account `gWJHostDepth` (default 6000/crossing,
  `GECKO_WJ_HELPCOST` overrides; `GECKO_WJ_HELPCROSDBG` logs
  `[wj-xrefuse]` refusals). Callers: `wjhelp` (all helper kinds EXCEPT
  `WJH_CALL`) and `WasmJitRunCall` (the JS->WJ dispatch edge). The
  account is separate from `gWJJitDepth` so a delegated PBL subtree
  (WJ bytes still high, watermark latched) keeps a full C++ budget.
- `WJH_CALL` is exempt because it delegates internally: its fast path
  checks `gWJSuspendWatermark` and falls to `JS::Call`, and a callee
  prologue flag-3.0 refusal does the same -- charging the helper edge
  would kill calls that could still run on PBL.
- Over-budget latches `gWJSuspendWatermark` so further JS->WJ edges
  delegate to PBL instead of re-charging; `WasmJitRunCall` returns 0
  (caller falls through to MaybeEnterJit/PBL -- the subtree runs on the
  heap shadow stack) while `wjhelp` reports `ReportOverRecursed` and
  returns the 1.0 threw-contract (a helper cannot delegate mid-frame).
- `wj_set_depth_limit` now honors `GECKO_WJ_DEPTHLIMIT`: the emit side
  bakes the env as a const but the C++ charge paths read
  `gWJJitDepthLimit`, which the calibration probe overwrote -- apply the
  env here so the WJ paths share one budget. `GECKO_HOSTLIMIT`
  (default 480000) sizes `gWJHostDepthLimit` independently.
- Scope guards restore `gWJHostDepth` and `jsExitFP` on every path so
  state stays consistent; the suspend watermark still latches on the
  WJ account (`gWJJitDepth`).

Verified (embed, warmed WJ path): a deep method-call chain now delegates
and COMPLETES (~1200 levels) instead of throwing, while non-delegable
shapes still trip `[wj-xrefuse]` -> catchable `InternalError: too much
recursion` with the engine alive -- previously an uncatchable
pthread-killing RangeError.

## 0013-emscripten-host-charge.patch

The remaining unguarded shapes are recursive paths that never re-enter a WJ
prologue: scripted getter/setter chains, method-call chains, and pure C++
recursion (JSON stringify/parse, ToSource, parser). All overflow the real
host stack the same way. These charge the dedicated host account
`gWJHostDepth` (NOT `gWJJitDepth`): an earlier shared-account design
starved delegated PBL subtrees, which kept running C++ frames while the
WJ byte total stayed pinned near its limit.

- `AutoCheckRecursionLimit` gains an optional `hostCharge` ctor arg
  (default 0 = unchanged). Under `__EMSCRIPTEN__` the ctor adds the charge
  to `gWJHostDepth` and the dtor refunds it (strict LIFO, same discipline
  as the WJ prologue save/restore), and `checkLimitImpl` fails when the
  account exceeds `gWJHostDepthLimit` (default 480000, `GECKO_HOSTLIMIT`
  overrides). Mirrors the `__wasi__` depth-count precedent already in
  the class.
- `RunScript` additionally charges every live interpreter activation
  (default 4000, `GECKO_HOSTCOST` overrides). This is the single choke
  point that covers PBL-dispatched getter/setter chains and nested
  native->script calls, which do not pass `js::CallGetter` or a WJ
  prologue.
- Site weights (measured per-level real costs): `SerializeJSONProperty`
  2400 (~2.4KB/level measured), `js::CallGetter`/`CallSetter` 1500 on top
  of the RunScript charge.

Measured (embed, defaults, no env) with the separate host account:
boundary-consuming chains (deep getter, JSON, sort-callback) throw
catchable `InternalError: too much recursion` with the engine alive,
while delegatable chains now COMPLETE -- plain recursion 30000 levels,
map-callback 4000, method-call 799, direct WJ call 1199 -- because the
delegated subtree runs PBL-internal frames that consume neither the WJ
nor the host account (and no real stack). Previously every shape above
hard-crashed the pthread. The bound is conservative by design
(defensive floor); raise `GECKO_HOSTLIMIT` or lower `GECKO_HOSTCOST`
if a real site needs deeper legit boundary nesting.

## 0014-wasmjit-pbl-inloop-call.patch

IC-dispatched scripted calls (`CallScriptedFunction` via `INVOKE_IC(Call)`)
used `PBL_CALL_INTERP` -- a C++ recursive call to `PortableBaselineInterpret`
costing ~10KB of real stack per level. On x.com-shaped workloads the
PBL->WJ->helper->`JS::Call`->`RunScript`->PBL ping-pong exhausted the host
account in ~120 levels and React's fiber walk died with `InternalError`
before mount, even though `GECKO_WJ_DEPTHLIMIT=1` (everything on PBL)
mounts it fine.

Non-native, non-constructing, non-specialized scripted calls now build the
callee frame directly on the PBL shadow stack: pushExitFrame (BaselineStub
boundary), arg copy with underflow padding, callee token + BaselineStub
descriptor + fake return address, pushFrame, switch ctx.frame/ctx.sp_, set
`ctx.inLoopSwitch`. `INVOKE_IC` detects the flag and jumps to the new
`inloop_switch` label, which finishes the callee prologue exactly like the
call-op fast path (nfixed undefined padding, env objects, debuggee,
interrupt, coverage) and dispatches. The existing `RetRval` path pops the
callee frame + synthetic boundary and resumes the caller's IC state, so
no C++ recursion and no real-stack cost per call level.

- `GECKO_WJ_NOINLOOP=1` reverts to `PBL_CALL_INTERP` (A/B testing).
- Before building the PBL frame the path still attempts
  `WasmJitRunCall` (hot callee stays WJ); the wasm attempt publishes
  `portableBaselineStack().top`/`jsExitFP`/`ctx.stack.fp` under a strict
  save/restore. `wjr==1` (handled) and `wjr==2` (threw) both pop the exit
  frame -- missing that pop leaked `ctx.stack.fp` into the caller operand
  area and corrupted the next frame walk (octane richards OOB).
- `ReportOverRecursed` failures run inside `PUSH_IC_FRAME()` so a covering
  VM frame exists on the error path.

Stack-accounting invariant that bit us during development:
`portableBaselineStack().top` is the activation's published floor; writes
are only valid inside a protected VM/native/wasm boundary window with a
paired restore. An early version wrote `top = sp` at `inloop_switch` with
no restore: each subsequent fresh PBL activation (`Stack` ctor reads `top`,
`PortablebaselineInterpreterStackCheck` budgets from it) started 264-528B
deeper per call -- `arr.flat`-shaped recursion ratcheted ~300B/call until
`InternalError` at ~6k iterations. Removed; ordinary execution now leaves
`top` untouched and leak reproducers run 20000 iterations flat.

Measured (embed): polyrec 10000-frame polymorphic chain completes
(r:10000 exact), underflow+recursion leak13 `done 20000`,
`arr.flat`-based kitchen-sink3 completes (previously InternalError at
i=6271), bound-function recursion now throws catchable InternalError
instead of an uncatchable trap. Full micro suite 23/23, realapp acorn +
marked OK, octane all 11 benches run, wiki:dom 2789 -> 1097 ms/iter.
ON/OFF (`GECKO_WJ_NOINLOOP=1`) microbench medians are within noise.

Known gaps (unchanged from before): `CallBoundScriptedFunction` and
getter/setter calls still use `PBL_CALL_INTERP` -- their return-continuation
operand counts differ from the Call convention (bound-arg expansion,
GetProp vs argc+2) and need the caller-operand rewrite before they can
share this path.
