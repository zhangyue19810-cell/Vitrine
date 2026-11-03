import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** Compile Java sources with the host JDK; returns the produced class files keyed by their jar path. */
export async function compileJava(workDir: string, sources: Record<string, string>): Promise<Record<string, Buffer>> {
  const src = join(workDir, "java-src");
  const out = join(workDir, "java-out");
  await mkdir(out, { recursive: true });
  const paths: string[] = [];
  for (const [name, text] of Object.entries(sources)) {
    const path = join(src, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    paths.push(path);
  }
  execFileSync("javac", ["-encoding", "UTF-8", "-d", out, ...paths], { stdio: "pipe" });
  const classes: Record<string, Buffer> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else classes[relative(out, full).split("\\").join("/")] = await readFile(full);
    }
  };
  await walk(out);
  return classes;
}

export function manifestFor(mainClass?: string): string {
  return `Manifest-Version: 1.0\r\n${mainClass ? `Main-Class: ${mainClass}\r\n` : ""}\r\n`;
}

/** A stand-in for an installer processor: behaviour is selected with `--task`. */
export const PROC_SOURCE = `
import java.io.*;
import java.nio.file.*;
import java.util.*;
public class Proc {
  public static void main(String[] a) throws Exception {
    Map<String,String> o = new HashMap<>();
    for (int i = 0; i < a.length; i++) if (a[i].startsWith("--") && i + 1 < a.length) { o.put(a[i], a[i + 1]); i++; }
    String log = System.getenv("PROC_LOG");
    String task = o.getOrDefault("--task", "");
    if (log != null) Files.write(Paths.get(log), (task + " " + String.join(" ", a) + "\\n").getBytes("UTF-8"), StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    System.out.println("proc task=" + task);
    if (task.equals("SERVER_ONLY")) System.exit(9);
    if (task.equals("FAIL")) { System.err.println("boom"); System.exit(1); }
    if (task.equals("DOWNLOAD_MOJMAPS")) {
      Path out = Paths.get(o.get("--output"));
      if (!Files.exists(out)) { System.err.println("would download mojmaps"); System.exit(2); }
      return;
    }
    if (task.equals("PATCH")) {
      byte[] in = Files.readAllBytes(Paths.get(o.get("--in")));
      byte[] patch = Files.readAllBytes(Paths.get(o.get("--patch")));
      byte[] out = new byte[in.length + patch.length];
      System.arraycopy(in, 0, out, 0, in.length);
      System.arraycopy(patch, 0, out, in.length, patch.length);
      Path dest = Paths.get(o.get("--out"));
      Files.createDirectories(dest.getParent());
      Files.write(dest, out);
    }
  }
}
`;
