import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCrash, collectCrashInput, recommendedJava } from "../src/crash/analyzer";

// The samples below follow the message formats of Fabric Loader, FML / NeoForge, Mixin and the HotSpot JVM as they are
// usually seen. They are written by hand, not captured from a corpus, so these tests pin the rules' behaviour only.

const find = (analysis: ReturnType<typeof analyzeCrash>, id: string) => analysis.findings.find((finding) => finding.id === id || finding.id.startsWith(`${id}-`));

describe("crash analysis rules", () => {
  it("recommends the Java a game version needs", () => {
    assert.equal(recommendedJava("1.12.2"), 8);
    assert.equal(recommendedJava("1.16.5"), 8);
    assert.equal(recommendedJava("1.18.2"), 17);
    assert.equal(recommendedJava("1.20.4"), 17);
    assert.equal(recommendedJava("1.20.6"), 21);
    assert.equal(recommendedJava("1.21.1"), 21);
    assert.equal(recommendedJava("26.1"), 21);
  });

  it("detects a Java that is too old and names the version to use", () => {
    const log = "java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0";
    const analysis = analyzeCrash({ log, javaMajor: 17 });
    const finding = find(analysis, "java-too-old");
    assert.ok(finding);
    assert.match(finding.title, /Java 21/);
    assert.deepEqual(finding.fix, { kind: "switch-java", major: 21 });
    // a Java that is new enough must not trigger it
    assert.equal(find(analyzeCrash({ log, javaMajor: 21 }), "java-too-old"), undefined);
  });

  it("detects a Java that is too new for old loaders", () => {
    const log = "Caused by: java.lang.IllegalArgumentException: Unsupported class file major version 65\n\tat org.objectweb.asm.ClassReader.<init>(ClassReader.java:196)";
    const finding = find(analyzeCrash({ log, mcVersion: "1.16.5" }), "java-too-new");
    assert.ok(finding);
    assert.deepEqual(finding.fix, { kind: "switch-java", major: 8 });
  });

  it("separates the different kinds of memory trouble", () => {
    const heap = analyzeCrash({ crashReport: "java.lang.OutOfMemoryError: Java heap space", maxMemoryMb: 4096 });
    assert.equal(heap.findings[0].id, "out-of-memory");
    assert.match(heap.findings[0].title, /heap/);
    const fix = heap.findings[0].fix;
    assert.equal(fix?.kind, "increase-memory");
    assert.ok(fix.kind === "increase-memory" && (fix.suggestMb ?? 0) > 4096);

    assert.match(analyzeCrash({ log: "java.lang.OutOfMemoryError: Metaspace" }).findings[0].title, /Metaspace/);
    assert.match(analyzeCrash({ log: "java.lang.OutOfMemoryError: Direct buffer memory" }).findings[0].title, /直接内存/);
    assert.match(analyzeCrash({ log: "java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached" }).findings[0].title, /线程/);
    const noJvm = analyzeCrash({ log: "Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap", maxMemoryMb: 8192 });
    assert.equal(noJvm.findings[0].id, "out-of-memory");
    assert.equal(noJvm.findings.some((f) => f.id === "jvm-args"), false, "the memory rule owns this message");
  });

  it("recognises bad JVM arguments", () => {
    const analysis = analyzeCrash({ log: "Unrecognized VM option 'UseConcMarkSweepGC'\nError: Could not create the Java Virtual Machine.\nError: A fatal exception has occurred. Program will exit." });
    const finding = find(analysis, "jvm-args");
    assert.ok(finding);
    assert.match(finding.detail, /UseConcMarkSweepGC/);
    assert.deepEqual(finding.fix, { kind: "reset-jvm-args" });
  });

  it("lists missing dependencies from Fabric, Forge and NeoForge messages and maps them to installed files", () => {
    const fabric = [
      "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
      "A potential solution has been determined, this may resolve your problem:",
      "\t - Install fabric-api, any version.",
      "\t - Install owo-lib, version 0.11.0 or later.",
      "More details:",
      "\t - Mod 'Create Fabric' (create) 0.5.1 requires any version of fabric-api, which is missing!",
      "\t - Mod 'Gadgets' (gadgets) 1.0 requires version 0.11.0 or later of owo-lib, which is missing!",
    ].join("\n");
    const a = find(analyzeCrash({ log: fabric }), "missing-dependency");
    assert.ok(a);
    assert.deepEqual([...(a.mods ?? [])].sort(), ["fabric-api", "owo-lib"]);
    assert.deepEqual(a.fix, { kind: "install-mods", modIds: a.mods });

    const forge = "Missing or unsupported mandatory dependencies:\n\tMod ID: 'geckolib', Requested by: 'create_sa', Expected range: '[4.4.9,)', Actual version: '[MISSING]'";
    const b = find(analyzeCrash({ log: forge, installedMods: [{ id: "create_sa", fileName: "create_sa-1.0.jar" }] }), "missing-dependency");
    assert.ok(b);
    assert.deepEqual(b.mods, ["geckolib"]);
    assert.match(b.detail, /create_sa-1\.0\.jar/);

    const neo = "Mod Create Sable requires create 6.0.0 or above\nCurrently, create is not installed";
    const c = find(analyzeCrash({ log: neo }), "missing-dependency");
    assert.ok(c);
    assert.deepEqual(c.mods, ["create"]);

    assert.equal(find(analyzeCrash({ log: "Mod ID: 'minecraft', Requested by: 'x', Expected range: '[1.20.1]', Actual version: '[MISSING]'" }), "missing-dependency"), undefined, "the game itself is not an installable mod");
  });

  it("detects mods built for another Minecraft or dependency version", () => {
    const fabric = "Mod 'Sodium' (sodium) 0.5.8 requires version [1.20.1] of minecraft, but only the wrong version is present: 1.20.4!";
    const a = find(analyzeCrash({ log: fabric }), "wrong-minecraft");
    assert.ok(a);
    assert.deepEqual(a.fix, { kind: "change-game-version", wanted: "[1.20.1]", actual: "1.20.4" });

    const forge = "\tMod ID: 'minecraft', Requested by: 'jei', Expected range: '[1.20.1,1.20.2)', Actual version: '1.21.1'";
    assert.ok(find(analyzeCrash({ log: forge }), "wrong-minecraft"));

    const dep = "Mod 'Iris' (iris) 1.7 requires version 0.5.8 or later of sodium, but only the wrong version is present: 0.4.0!";
    const b = find(analyzeCrash({ log: dep }), "wrong-version");
    assert.ok(b);
    assert.deepEqual(b.mods, ["iris", "sodium"]);
  });

  it("finds duplicate mods", () => {
    const log = "Found duplicate mods:\n\tMod ID: 'jei' from mod files: jei-1.20.1-15.2.jar, jei-1.20.1-15.3.jar";
    const finding = find(analyzeCrash({ log }), "duplicate-mods");
    assert.ok(finding);
    assert.deepEqual(finding.mods, ["jei"]);
    assert.match(finding.detail, /jei-1\.20\.1-15\.3\.jar/);
  });

  it("points Mixin failures at the mod and its jar", () => {
    const log = "[main/ERROR]: Mixin apply for mod create failed create.mixins.json:AbstractContraptionEntityMixin from mod create -> net.minecraft.world.entity.Entity: org.spongepowered.asm.mixin.injection.throwables.InjectionError: Critical injection failure";
    const analysis = analyzeCrash({ log, installedMods: [{ id: "create", fileName: "create-fabric-0.5.1.jar" }] });
    const finding = find(analysis, "mixin-failure");
    assert.ok(finding);
    assert.deepEqual(finding.mods, ["create"]);
    assert.deepEqual(finding.fix, { kind: "disable-mods", modIds: ["create"], files: ["create-fabric-0.5.1.jar"] });
  });

  it("explains linkage errors", () => {
    const report = "java.lang.NoSuchMethodError: 'void net.minecraft.client.renderer.LevelRenderer.setSectionDirty(int, int, int)'\n\tat me.jellysquid.mods.sodium.client.render.SodiumWorldRenderer.reload(SodiumWorldRenderer.java:214)";
    const finding = find(analyzeCrash({ crashReport: report }), "linkage");
    assert.ok(finding);
    assert.match(finding.detail, /setSectionDirty/);
  });

  it("recognises graphics driver problems and native JVM crashes", () => {
    assert.ok(find(analyzeCrash({ log: "[Render thread/ERROR]: GLFW error 65542: WGL: The driver does not appear to support OpenGL" }), "opengl"));
    assert.ok(find(analyzeCrash({ log: "org.lwjgl.LWJGLException: Pixel format not accelerated" }), "opengl"));

    const hs = "# A fatal error has been detected by the Java Runtime Environment:\n#\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffa1c0e2b10, pid=1234, tid=5678\n#\n# Problematic frame:\n# C  [nvoglv64.dll+0x1d2b10]\n";
    const finding = find(analyzeCrash({ hsErr: hs }), "jvm-crash");
    assert.ok(finding);
    assert.match(finding.title, /NVIDIA/);
    assert.deepEqual(finding.fix, { kind: "update-graphics-driver", vendor: "NVIDIA" });
  });

  it("recognises corrupt jars, missing main class, config syntax errors, full disks, locked files and stale sessions", () => {
    const corrupt = find(analyzeCrash({ log: "java.util.zip.ZipException: zip END header not found\n\tat mods/broken-mod-1.0.jar" }), "corrupt-jar");
    assert.ok(corrupt);
    assert.deepEqual(corrupt.fix, { kind: "repair-files" });
    assert.ok(find(analyzeCrash({ log: "Error: Could not find or load main class net.minecraft.client.main.Main" }), "missing-main-class"));
    const config = find(analyzeCrash({ log: "com.electronwill.nightconfig.core.io.ParsingException: Failed to parse config file create-server.toml" }), "config-error");
    assert.ok(config);
    assert.equal(config.fix?.kind, "check-config");
    assert.ok(find(analyzeCrash({ log: "java.io.IOException: No space left on device" }), "disk-full"));
    assert.ok(find(analyzeCrash({ log: "java.nio.file.AccessDeniedException: C:\\games\\.minecraft\\saves\\x\\session.lock" }), "file-locked"));
    assert.ok(find(analyzeCrash({ log: "Disconnected: Invalid session (Try restarting your game)" }), "session"));
  });

  it("explains ticking entities and block entities with their locations", () => {
    const entity = [
      "---- Minecraft Crash Report ----",
      "Time: 2026-10-23 10:00:00",
      "Description: Ticking entity",
      "",
      "java.lang.NullPointerException: Ticking entity",
      "-- Entity being ticked --",
      "Details:",
      "\tEntity Type: create:contraption (com.simibubi.create.content.contraptions.Contraption)",
      "\tEntity's Exact location: 101.50, 64.00, -2000.25",
    ].join("\n");
    const a = analyzeCrash({ crashReport: entity });
    const finding = find(a, "ticking-entity");
    assert.ok(finding);
    assert.match(finding.title, /create:contraption/);
    assert.match(finding.detail, /102, 64, -2000/); // 101.50 rounds to 102
    assert.deepEqual(finding.mods, ["create"]);
    assert.equal(a.description, "Ticking entity");

    const block = [
      "Description: Ticking block entity",
      "java.lang.IllegalStateException: boom",
      "-- Block entity being ticked --",
      "Details:",
      "\tName: create:mechanical_bearing // com.simibubi.create.Bearing",
      "\tBlock: Block{create:mechanical_bearing}",
      "\tBlock location: World: (100,64,200), Section: (at 4,0,8 in 6,4,12)",
    ].join("\n");
    const b = find(analyzeCrash({ crashReport: block }), "ticking-block-entity");
    assert.ok(b);
    assert.match(b.detail, /100, 64, 200/);
  });

  it("falls back to suspected mods, exit codes and an honest 'unknown'", () => {
    const report = "Description: Rendering entity in world\njava.lang.RuntimeException: bad\nSuspected Mods: Create (create), Flywheel (flywheel)\n";
    const a = analyzeCrash({ crashReport: report });
    assert.equal(a.findings[0].id, "suspected-mods");
    assert.deepEqual(a.suspectedMods, ["create", "flywheel"]);
    assert.equal(a.rootException, "java.lang.RuntimeException: bad");

    const none = analyzeCrash({ crashReport: "Description: x\nSuspected Mods: NONE\njava.lang.IllegalStateException: odd" });
    assert.equal(none.findings[0].id, "unknown");
    assert.deepEqual(none.suspectedMods, []);

    assert.equal(analyzeCrash({ exitCode: -1073740791 }).findings[0].id, "native-crash-exit");
    assert.equal(analyzeCrash({ exitCode: 137 }).findings[0].id, "killed");
    assert.equal(analyzeCrash({ exitCode: 1 }).findings[0].id, "unknown");
  });

  it("orders errors before warnings and survives hostile input", () => {
    const log = "AccessDeniedException: x\njava.lang.OutOfMemoryError: Java heap space\n" + "x".repeat(50_000);
    const a = analyzeCrash({ log });
    assert.equal(a.findings[0].severity, "error");
    const started = Date.now();
    analyzeCrash({ log: `Mod '${"a".repeat(30000)}' (`.repeat(20) + "requires " + " of ".repeat(20000) });
    analyzeCrash({ log: "Mod ".repeat(50000) + "requires x\n" });
    assert.ok(Date.now() - started < 3000, "no pathological regex behaviour");
  });
});

describe("collectCrashInput", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vitrine-crash-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the newest crash report, the log tail and an hs_err file, ignoring stale ones", async () => {
    await mkdir(join(dir, "crash-reports"), { recursive: true });
    await mkdir(join(dir, "logs"), { recursive: true });
    const old = join(dir, "crash-reports", "crash-2020-01-01_00.00.00-client.txt");
    const fresh = join(dir, "crash-reports", "crash-2026-10-23_10.00.00-client.txt");
    await writeFile(old, "OLD REPORT");
    await writeFile(fresh, "FRESH REPORT");
    await utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await writeFile(join(dir, "logs", "latest.log"), "line\n".repeat(200_000));
    await writeFile(join(dir, "hs_err_pid42.log"), "# A fatal error");

    const got = await collectCrashInput(dir, { since: Date.now() - 60_000 });
    assert.equal(got.crashReport, "FRESH REPORT");
    assert.ok(got.crashReportPath?.endsWith("client.txt"));
    assert.ok((got.log?.length ?? 0) <= 768 * 1024 && (got.log?.length ?? 0) > 1000);
    assert.equal(got.hsErr, "# A fatal error");

    const none = await collectCrashInput(dir, { since: Date.now() + 60_000 });
    assert.equal(none.crashReport, undefined);
    assert.equal(none.log, undefined);
    assert.deepEqual(await collectCrashInput(join(dir, "missing")), {});
  });
});

describe("main class errors", () => {
  it("blames the files, not the mods, when the JVM cannot find the main class (whatever its name)", () => {
    const log = "Error: Could not find or load main class net.minecraft.launchwrapper.Launch\nCaused by: java.lang.ClassNotFoundException: net.minecraft.launchwrapper.Launch";
    const analysis = analyzeCrash({ log });
    assert.equal(analysis.findings[0].id, "missing-main-class");
    assert.equal(analysis.findings.some((finding) => finding.id === "linkage"), false);
    assert.deepEqual(analysis.findings[0].fix, { kind: "repair-files" });
  });
});
