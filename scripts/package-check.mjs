#!/usr/bin/env node
// Audit a Node project's package.json, lockfile and install config. Pack: javascript-node, rules
// js-package-hygiene, js-supply-chain, js-eslint-flat. No dependencies. Usage: node package-check.mjs [ROOT]
// Exit 0 when clean, 1 with one line per problem.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.argv[2] ?? "."
const problems = []
const read = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : null)

const raw = read("package.json")
if (raw === null) {
  console.log("package-check: no package.json, nothing to check")
  process.exit(0)
}
let pkg
try {
  pkg = JSON.parse(raw)
} catch (err) {
  console.log(`package.json is not valid JSON: ${err.message}`)
  process.exit(1)
}

if (pkg.type !== "module" && pkg.type !== "commonjs") problems.push('package.json needs an explicit "type" ("module" for new code)')
if (!pkg.engines?.node) problems.push("package.json needs engines.node (pin the Node line the project runs on)")

const sections = ["dependencies", "devDependencies", "optionalDependencies"]
for (const section of sections) {
  for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    const s = String(spec).trim()
    if (s === "*" || s === "" || s === "latest" || s === "x") problems.push(`${section}.${name} is unpinned ("${s}"); use a version range`)
    else if (/^(git[+:]|github:|gitlab:|bitbucket:|https?:|file:|link:)/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) {
      problems.push(`${section}.${name} is a git, URL or path dependency ("${s}"); npm 12 blocks these by default`)
    }
  }
}

for (const hook of ["preinstall", "install", "postinstall"]) {
  if (pkg.scripts?.[hook]) problems.push(`scripts.${hook} runs on every install of this package; remove it or move it to an explicit script`)
}

const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].filter((f) => existsSync(join(root, f)))
if (lockfiles.length === 0) problems.push("no lockfile committed (package-lock.json, pnpm-lock.yaml or yarn.lock)")
if (lockfiles.length > 1) problems.push(`more than one lockfile (${lockfiles.join(", ")}); keep one lockfile for one package manager`)

const legacy = readdirSync(root).filter((f) => f.startsWith(".eslintrc"))
if (legacy.length) problems.push(`legacy ESLint config ${legacy.join(", ")} (ESLint 10 ignores eslintrc; use eslint.config.mjs)`)

const npmrc = read(".npmrc") ?? ""
const workspace = read("pnpm-workspace.yaml") ?? ""
const hasReleaseAge = /^\s*min-release-age\s*=\s*[1-9]/m.test(npmrc) || /^\s*minimumReleaseAge\s*:\s*[1-9]/m.test(workspace)
if (!hasReleaseAge) problems.push("no release age set: add min-release-age to .npmrc (npm) or minimumReleaseAge to pnpm-workspace.yaml (pnpm)")

if (problems.length) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
console.log("package-check: clean")
