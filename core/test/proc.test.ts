import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanJavaEnv, javaHomeFromExecutable } from "../src/util/proc";

describe("JVM child environment", () => {
  it("drops ambient boot options and points JAVA_HOME at the selected JDK", () => {
    const env = cleanJavaEnv(
      {
        PATH: "/usr/bin",
        JAVA_TOOL_OPTIONS: "-Xbootclasspath/a:/missing.jar",
        _JAVA_OPTIONS: "-Xmx1g",
        JDK_JAVA_OPTIONS: "-Dbroken=true",
        JAVA_OPTS: "-Xbootclasspath/p:/old.jar",
        CLASSPATH: "/old.jar",
        BOOTCLASSPATH: "/old/boot.jar",
        JAVA_HOME: "/old/java",
      },
      undefined,
      "/opt/jdk-21/bin/java",
    );
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.JAVA_HOME, "/opt/jdk-21");
    assert.equal(env.JAVA_TOOL_OPTIONS, undefined);
    assert.equal(env._JAVA_OPTIONS, undefined);
    assert.equal(env.JDK_JAVA_OPTIONS, undefined);
    assert.equal(env.JAVA_OPTS, undefined);
    assert.equal(env.CLASSPATH, undefined);
    assert.equal(env.BOOTCLASSPATH, undefined);
  });

  it("keeps explicit instance options but does not infer a home for PATH lookups", () => {
    const env = cleanJavaEnv(
      { JAVA_HOME: "/old/java", JAVA_TOOL_OPTIONS: "-Dambient=1" },
      { JAVA_TOOL_OPTIONS: "-Dexplicit=1", JAVA_HOME: "/custom/jdk" },
      "java",
    );
    assert.equal(env.JAVA_TOOL_OPTIONS, "-Dexplicit=1");
    assert.equal(env.JAVA_HOME, "/custom/jdk");
    assert.equal(javaHomeFromExecutable("java"), undefined);
    assert.equal(javaHomeFromExecutable("/opt/jdk-17/bin/java"), "/opt/jdk-17");
  });
});
