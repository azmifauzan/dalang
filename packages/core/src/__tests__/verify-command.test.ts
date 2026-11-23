import { describe, expect, it } from "vitest";
import { localizeVerifyCommand } from "../services/verify-command.js";

const root = "/home/u/sei-office";

describe("localizeVerifyCommand", () => {
  it("drops a leading cd into the project and keeps the rest", () => {
    expect(
      localizeVerifyCommand(
        `cd ${root} && tail -n1 frontend/README.md && git -C frontend diff --stat`,
        root,
      ),
    ).toBe("tail -n1 frontend/README.md && git -C frontend diff --stat");
  });

  it("relativizes absolute file arguments and a bare project path", () => {
    expect(
      localizeVerifyCommand(
        `php -l ${root}/frontend/a.php && ls ${root}`,
        root,
      ),
    ).toBe("php -l frontend/a.php && ls .");
  });

  it("handles quoted cd, a trailing slash on the root, and cd after another command", () => {
    expect(localizeVerifyCommand(`true; cd "${root}/" ; npm test`, root)).toBe(
      "true; npm test",
    );
  });

  it("leaves commands, sibling paths, and other directories alone", () => {
    expect(localizeVerifyCommand("npm test", root)).toBe("npm test");
    expect(localizeVerifyCommand(`ls ${root}-other/x`, root)).toBe(
      `ls ${root}-other/x`,
    );
    expect(localizeVerifyCommand("cd /elsewhere && ls", root)).toBe(
      "cd /elsewhere && ls",
    );
  });
});
