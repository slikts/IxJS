const del = require(`del`);
const gulp = require(`gulp`);
const path = require(`path`);
const pump = require(`pump`);
const ts = require(`gulp-typescript`);
const streamMerge = require(`merge2`);
const sourcemaps = require(`gulp-sourcemaps`);
const child_process = require(`child_process`);
const gulpJsonTransform = require(`gulp-json-transform`);
const closureCompiler = require(`google-closure-compiler`).gulp();

const knownTargets = [`es5`, `es2015`, `esnext`];
const knownModules = [`cjs`, `esm`, `cls`, `umd`];

// see: https://github.com/google/closure-compiler/blob/c1372b799d94582eaf4b507a4a22558ff26c403c/src/com/google/javascript/jscomp/CompilerOptions.java#L2988
const gCCTargets = {
  es5: `ECMASCRIPT5`,
  es2015: `ECMASCRIPT_2015`,
  es2016: `ECMASCRIPT_2016`,
  es2017: `ECMASCRIPT_2017`,
  esnext: `ECMASCRIPT_NEXT`
};

const tsProjects = [];
const argv = require(`command-line-args`)([
  { name: `all`, alias: `a`, type: Boolean },
  { name: `target`, type: String, defaultValue: `` },
  { name: `module`, type: String, defaultValue: `` },
  { name: `targets`, alias: `t`, type: String, multiple: true, defaultValue: [] },
  { name: `modules`, alias: `m`, type: String, multiple: true, defaultValue: [] }
]);

const { targets, modules } = argv;

argv.target && !targets.length && targets.push(argv.target);
argv.module && !modules.length && modules.push(argv.module);
(argv.all || (!targets.length && !modules.length))
  && targets.push('all') && modules.push(`all`);

for (const [target, format] of combinations([`all`, `all`])) {
  const combo = `${target}:${format}`;
  gulp.task(`test:${combo}`, ...testTask(target, format, combo, `targets/${target}/${format}`));
  gulp.task(`build:${combo}`, ...buildTask(target, format, combo, `targets/${target}/${format}`));
  gulp.task(`clean:${combo}`, ...cleanTask(target, format, combo, `targets/${target}/${format}`));
  gulp.task(`bundle:${combo}`, ...bundleTask(target, format, combo, `targets/${target}/${format}`));
}
gulp.task(`build:ts`, ...copySrcTask(`ts`, ``, `ts`, `targets/ts`));
gulp.task(`clean:ts`, ...cleanTask(`ts`, ``, `ts`, `targets/ts`));
gulp.task(`bundle:ts`, ...bundleTask(`ts`, ``, `ts`, `targets/ts`));

gulp.task(`default`, [`build`]);
gulp.task(`test`, (cb) => runTaskCombos(`test`, cb));
gulp.task(`clean`, (cb) => runTaskCombos(`clean`, cb));
gulp.task(`build`, (cb) => runTaskCombos(`bundle`, cb));

function runTaskCombos(name, cb) {
  const combos = [];
  // unsure how to execute tests against closure target
  const skipTestFormats = { cls: true };
  for (const [target, format] of combinations(targets, modules)) {
    if (name === 'test' && format in skipTestFormats) {
      continue;
    }
    combos.push(`${name}:${target}:${format}`);
  }
  if (name === `bundle`) {
    if (~targets.indexOf(`ts`)) {
      combos.push(`${name}:ts`);
    } else if (targets[0] === `all` && modules[0] === `all`) {
      combos.push(`${name}:ts`);
    }
  }
  gulp.start(combos, cb);
}

function cleanTask(target, format, taskName, outDir) {
  return [
    () => {
      const globs = [`${outDir}/**`];
      if (target === `es5` && format === `cjs`) {
          globs.push(`types`);
      }
      return del(globs);
    }
  ];
}

function buildTask(target, format, taskName, outDir) {
  return format === `umd`
    ? closureTask(target, format, taskName, outDir)
    :  format === `cls`
    ? tsickleTask(target, format, taskName, outDir)
    : typescriptTask(target, format, taskName, outDir);
}

function copySrcTask(target, format, taskName, outDir) {
  return [
    [`clean:${taskName}`],
    () => gulp.src([`src/**/*`]).pipe(gulp.dest(outDir))
  ];
}

function bundleTask(target, format, taskName, outDir) {
  const nameComponents = [target];
  const ext = target === `ts` ? `ts` : `js`;
  const typings = target === `ts` ? `Ix.ts` : null;
  if (format) {
    nameComponents.push(format);
  }
  return [
    [`build:${taskName}`],
    (cb) => streamMerge([
      pump(gulp.src([`LICENSE`, `readme.md`, `CHANGELOG.md`]), gulp.dest(outDir)),
      pump(
        gulp.src(`package.json`),
        gulpJsonTransform((orig) => [
          `version`, `description`,
          `author`, `homepage`, `bugs`,
          `license`, `keywords`, `typings`,
          `repository`, `peerDependencies`
        ].reduce((copy, key) => (
          (copy[key] = copy[key] || orig[key]) && copy || copy
        ), {
          typings,
          main: `Ix.${ext}`,
          name: `@reactivex/${[orig.name, ...nameComponents].join('-')}`
        }), 2),
        gulp.dest(outDir),
        onError
      )
    ])
  ];
}

function testTask(target, format, taskName, outDir) {
  const tapReporter = require(`tap-difflet`);
  const reporterOpts = { pessimistic: true };
  const specTSConfigPath = `./spec/tsconfig.json`;
  const forkOptions = {
    execPath: `ts-node`,
    execArgv: [`--harmony_async_iteration`],
    stdio: [`ignore`, `pipe`, `inherit`, `ipc`],
    env: Object.assign({}, process.env, {
      TS_NODE_FAST: true,
      TS_NODE_CACHE: false,
      TS_NODE_PROJECT: specTSConfigPath
    })
  };
  return [
    (cb) => {
      const reporter = tapReporter(reporterOpts);
      const proc = child_process.fork(
        `spec/index.ts`, [
          `--target`, target,
          `--module`, format
        ],
        forkOptions
      );
      proc.on(`error`, onError);
      proc.on(`close`, (x) => cb());
      pump(proc.stdout, reporter, process.stdout, onError);
    }
  ];
}

function tsickleTask(target, format, taskName, outDir) {
  return [
    [`clean:${taskName}`],
    (cb) => {
      const tsickleBin = require.resolve(`tsickle/built/src/main`);
      const proc = child_process.fork(
        tsickleBin, [
          `--externs`, `${outDir}/Ix.externs.js`,
          `--typed`, `--`, `-p`, `tsconfig/${target}.${format}/`
        ],
        { stdio: [`ignore`, `inherit`, `inherit`, `ipc`] }
      );
      proc.on(`error`, onError);
      proc.on(`close`, (x) => cb());
    }
  ];
}

function closureTask(target, format, taskName, outDir) {
  const clsTarget = `es5`;
  const googleRoot = `targets/${clsTarget}/cls`;
  const sourceGlob = `${googleRoot}/**/*.js`;
  const externsPath = `${googleRoot}/Ix.externs.js`;
  return [
    [`clean:${taskName}`, `build:${clsTarget}:cls`],
    (cb) => {
      return streamMerge([
        closureStream(closureSrcs(), `Ix`, onError, true),
        closureStream(closureSrcs(), `Ix.internal`, onError)
      ]);
    }
  ];
  function closureSrcs() {
    return gulp.src([
      `scripts/tslib.js`, sourceGlob, `!${externsPath}`
    ], { base: `./` });
  }
  function closureStream(sources, entry, onError, copyToDist) {
    const streams = [
      sources,
      sourcemaps.init(),
      closureCompiler(closureArgs(entry)),
      sourcemaps.write('.'),
      gulp.dest(outDir)
    ];
    // copy the UMD bundle to dist
    if (target === `es5` && copyToDist) {
      streams.push(gulp.dest(`dist`))
    }
    return pump(...streams, onError);
  }
  function closureArgs(entry) {
    return {
      externs: externsPath,
      warning_level: `QUIET`,
      dependency_mode: `LOOSE`,
      rewrite_polyfills: false,
      // formatting: `PRETTY_PRINT`,
      module_resolution: `LEGACY`,
      compilation_level: `ADVANCED`,
      assume_function_wrapper: true,
      js_output_file: `${entry}.js`,
      language_out: gCCTargets[`es5`],
      language_in: gCCTargets[clsTarget],
      entry_point: `targets.${clsTarget}.cls.${entry}`,
      output_wrapper: `(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (factory(global.Ix = global.Ix || {}));
}(this, (function (exports) {%output%}.bind(this))));`
    };
  }
}

function typescriptTask(target, format, taskName, outDir) {
  return [
    [`clean:${taskName}`],
    (cb) => {
      const tsconfigPath = `tsconfig/tsconfig.${target}.${format}.json`;
      const { tsProject } = (
        tsProjects.find((p) => p.target === target && p.format === format) ||
        tsProjects[-1 + tsProjects.push({
          target, format, tsProject: ts.createProject(tsconfigPath)
        })]
      );
      const { js, dts } = pump(
        tsProject.src(),
        sourcemaps.init(),
        tsProject(ts.reporter.fullReporter(true)),
        onError
      );
      const dtsStreams = [dts, gulp.dest(`${outDir}/types`)];
      const jsStreams = [js, sourcemaps.write(), gulp.dest(outDir)];
      // copy types to the root
      if (target === `es5` && format === `cjs`) {
        dtsStreams.push(gulp.dest(`types`));
      }
      return streamMerge([
        pump(...dtsStreams, onError),
        pump(...jsStreams, onError)
      ]);
    }
  ];
}

function onError(err) {
  if (typeof err === 'number') {
      process.exit(err);
  } else if (err) {
      console.error(err.stack || err.toString());
      process.exit(1);
  }
}

function* combinations(_targets, _modules) {

  const targets = known(knownTargets, _targets || [`all`]);
  const modules = known(knownModules, _modules || [`all`]);

  for (const format of modules) {
    for (const target of targets) {
      yield [target, format];
    }
  }

  function known(known, values) {
    return ~values.indexOf(`all`)
      ? known
      : Object.keys(
        values.reduce((map, arg) => ((
          (known.indexOf(arg) !== -1) &&
          (map[arg.toLowerCase()] = true)
          || true) && map
        ), {})
      ).sort((a, b) => known.indexOf(a) - known.indexOf(b));
  }
}
