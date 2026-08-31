/**
 * Policy tests. Deterministic and offline -- no model calls, no quota.
 *
 * The evasion block matters more than the happy path: a guardrail that only catches the
 * obvious spelling of a command is worse than none, because it reads as protection.
 */
import { Policy } from "../src/core/policy.js";
import path from "node:path";
import os from "node:os";

const PROJECT = "/Users/someone/work/myrepo";
const policy = new Policy({ projectDir: PROJECT });

let passed = 0;
let failed = 0;

function expectDeny(tool: string, input: unknown, label: string) {
  const d = policy.check(tool, input);
  if (!d.allow) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m deny  ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m deny  ${label}  \x1b[31m<-- ALLOWED, should have been denied\x1b[0m`);
  }
}

function expectAllow(tool: string, input: unknown, label: string) {
  const d = policy.check(tool, input);
  if (d.allow) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m allow ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m allow ${label}  \x1b[31m<-- DENIED: ${d.reason}\x1b[0m`);
  }
}

const bash = (command: string) => ({ command });

console.log("\ngit history writes -- the invariant rollback depends on");
expectDeny("Bash", bash("git commit -m 'wip'"), "git commit");
expectDeny("Bash", bash("git reset --hard HEAD~1"), "git reset --hard");
expectDeny("Bash", bash("git checkout -b feature"), "git checkout -b");
expectDeny("Bash", bash("git switch main"), "git switch");
expectDeny("Bash", bash("git stash"), "git stash");
expectDeny("Bash", bash("git clean -fd"), "git clean -fd");
expectDeny("Bash", bash("git push origin main"), "git push");
expectDeny("Bash", bash("git rebase -i HEAD~3"), "git rebase");
expectDeny("Bash", bash("git add -A"), "git add");
expectDeny("Bash", bash("git update-ref refs/heads/main HEAD"), "git update-ref");

console.log("\ngit reads -- must stay available or the builder is blind");
expectAllow("Bash", bash("git status --porcelain"), "git status");
expectAllow("Bash", bash("git diff HEAD"), "git diff");
expectAllow("Bash", bash("git log --oneline -20"), "git log");
expectAllow("Bash", bash("git show HEAD:src/index.ts"), "git show");
expectAllow("Bash", bash("git rev-parse --abbrev-ref HEAD"), "git rev-parse");
expectAllow("Bash", bash("git ls-files 'src/**'"), "git ls-files");
expectAllow("Bash", bash("git blame src/index.ts"), "git blame");

console.log("\nevasion -- the whole point of parsing rather than prefix-matching");
expectDeny("Bash", bash("echo hello; git push"), "hidden after ;");
expectDeny("Bash", bash("true && git reset --hard"), "hidden after &&");
expectDeny("Bash", bash("false || git commit -m x"), "hidden after ||");
expectDeny("Bash", bash("git status | grep foo && git commit -m x"), "hidden after a pipe + &&");
expectDeny("Bash", bash("echo $(git commit -m sneaky)"), "inside $( )");
expectDeny("Bash", bash("echo `git push`"), "inside backticks");
expectDeny("Bash", bash("echo $(echo $(git push))"), "nested $( )");
expectDeny("Bash", bash("FOO=bar git push"), "behind an env assignment");
expectDeny("Bash", bash("git 'push' origin"), "quoted subcommand");
expectDeny("Bash", bash('git "commit" -m x'), "double-quoted subcommand");
expectDeny("Bash", bash("ls\ngit commit -m x"), "on a second line");
expectDeny("Bash", bash("/usr/bin/git commit -m x"), "invoked by absolute path");
expectDeny("Bash", bash("git -C /tmp/other push"), "relocated with -C");
expectDeny("Bash", bash("git --git-dir=/tmp/x/.git commit -m y"), "relocated with --git-dir");
expectDeny("Bash", bash("git --work-tree=/ checkout ."), "relocated with --work-tree");

console.log("\nprivileged and outward-facing commands");
expectDeny("Bash", bash("sudo rm -rf /"), "sudo");
expectDeny("Bash", bash("security find-generic-password -s 'Claude Code-credentials' -w"), "keychain read");
expectDeny("Bash", bash("npm publish"), "npm publish");
expectDeny("Bash", bash("gh pr create --title x"), "gh pr create");
expectDeny("Bash", bash("gh release create v1.0.0"), "gh release create");
expectDeny("Bash", bash("docker push myimage"), "docker push");
expectDeny("Bash", bash("launchctl load ~/Library/LaunchAgents/x.plist"), "launchctl");
expectDeny("Bash", bash("crontab -e"), "crontab");

console.log("\nordinary development work must not be obstructed");
expectAllow("Bash", bash("npm test"), "npm test");
expectAllow("Bash", bash("npm run build && npm test"), "chained build + test");
expectAllow("Bash", bash("node --test test/"), "node --test");
expectAllow("Bash", bash("ls -la src/"), "ls");
expectAllow("Bash", bash("grep -rn 'TODO' src/ | head -20"), "grep piped to head");
expectAllow("Bash", bash("cat package.json"), "cat");
expectAllow("Bash", bash("mkdir -p src/utils && touch src/utils/index.ts"), "mkdir + touch");
expectAllow("Bash", bash("npx tsc --noEmit"), "npx tsc");
expectAllow("Bash", bash("python3 -c 'print(1)'"), "python one-liner");
expectAllow("Bash", bash("echo 'git commit is mentioned in this string'"), "git named inside a quoted string only");

console.log("\nfile writes");
expectAllow("Write", { file_path: `${PROJECT}/src/index.ts` }, "inside the project");
expectAllow("Write", { file_path: "src/nested/deep.ts" }, "relative path inside the project");
expectDeny("Write", { file_path: "/etc/hosts" }, "absolute path outside the project");
expectDeny("Write", { file_path: `${PROJECT}/../sibling/x.ts` }, "traversal out with ..");
expectDeny("Write", { file_path: "~/.bashrc" }, "home directory via ~");
expectDeny("Write", { file_path: `${PROJECT}/.git/config` }, "inside .git");
expectDeny("Write", { file_path: `${PROJECT}/.git/hooks/pre-commit` }, "a git hook");
expectDeny("Edit", { file_path: path.join(os.homedir(), ".aws/credentials") }, "~/.aws/credentials");
expectDeny("Write", { file_path: path.join(os.homedir(), ".ssh/authorized_keys") }, "~/.ssh/authorized_keys");

console.log("\ncredential reads");
expectDeny("Read", { file_path: path.join(os.homedir(), ".ssh/id_rsa") }, "~/.ssh/id_rsa");
expectDeny("Read", { file_path: path.join(os.homedir(), ".codex/auth.json") }, "~/.codex/auth.json");
expectAllow("Read", { file_path: "/usr/lib/node_modules/npm/package.json" }, "a system file that is not a credential");
expectAllow("Read", { file_path: `${PROJECT}/src/index.ts` }, "a project file");

console.log("\nread-only mode — while the user is still deciding, nothing may be written");
{
  const ro = new Policy({ projectDir: PROJECT, readOnly: true });
  const check = (cond: boolean, label: string) => {
    cond ? passed++ : failed++;
    console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}`);
  };
  const denies = (cmd: string) => !ro.check("Bash", { command: cmd }).allow;
  const allows = (cmd: string) => ro.check("Bash", { command: cmd }).allow;

  check(!ro.check("Write", { file_path: `${PROJECT}/src/a.ts` }).allow, "deny  Write inside the project");
  check(!ro.check("Edit", { file_path: `${PROJECT}/src/a.ts` }).allow, "deny  Edit inside the project");
  check(denies("rm -rf build/"), "deny  rm");
  check(denies("mv a.ts b.ts"), "deny  mv");
  check(denies("mkdir -p src/new"), "deny  mkdir");
  check(denies("sed -i '' 's/a/b/' file.ts"), "deny  sed -i (in-place edit)");
  check(denies("echo hi > notes.txt"), "deny  > redirect");
  check(denies("cat a.txt >> b.txt"), "deny  >> redirect");
  check(denies("grep foo src/ | tee out.txt"), "deny  tee behind a pipe");
  check(denies("ls && echo x > f"), "deny  redirect in a later segment");

  check(allows("ls -la src/"), "allow ls");
  check(allows("cat package.json"), "allow cat");
  check(allows("grep -rn TODO src/"), "allow grep");
  check(allows("git log --oneline -20"), "allow git log");
  check(allows("sed -n '1,40p' calc.js"), "allow sed without -i (read-only filter)");
  check(allows("npm test 2>&1"), "allow 2>&1 (merges descriptors, writes nothing)");
  check(allows("echo \"write a > b\""), "allow > inside a quoted string");
  check(ro.check("Read", { file_path: `${PROJECT}/src/a.ts` }).allow, "allow Read");
}

console.log("\nopt-outs");
{
  const loose = new Policy({ projectDir: PROJECT, allowGitWrites: true, allowPublish: true });
  const a = loose.check("Bash", bash("git commit -m x"));
  const b = loose.check("Bash", bash("npm publish"));
  const c = loose.check("Bash", bash("sudo rm -rf /"));
  const check = (cond: boolean, label: string) => {
    cond ? passed++ : failed++;
    console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}`);
  };
  check(a.allow, "allowGitWrites re-enables git commit");
  check(b.allow, "allowPublish re-enables npm publish");
  check(!c.allow, "sudo stays denied even with both opt-outs (not overridable)");
}

console.log(
  `\n${failed === 0 ? "\x1b[32m" : "\x1b[31m"}${passed} passed, ${failed} failed\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
