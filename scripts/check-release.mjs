import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function walk(dir) {
 const result=[]
 for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
  if (['.git','.test-tmp','node_modules','dist'].includes(entry.name)) continue
  const full=path.join(dir,entry.name)
  assert(!entry.isSymbolicLink(), `Unexpected symlink: ${full}`)
  if(entry.isDirectory()) result.push(...await walk(full)); else result.push(full)
 }
 return result
}
const files=await walk(root)
for(const file of files) {
 const rel=path.relative(root,file).replaceAll('\\','/')
 assert(!/^(native\/(control|releases)|install-records|runs|history)\//.test(rel), `Private runtime data: ${rel}`)
 assert(!/(^|\/)(installer\.(local|config)\.json|\.env)$/.test(rel), `Local config: ${rel}`)
 const txt=await fs.readFile(file,'utf8')
 // Reject machine-specific usernames and likely credentials without printing matches.
 assert(!/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(txt), `Credential-like content: ${rel}`)
 assert(!/[A-Za-z]:[\\/]Users[\\/][^<>/\\\s]+/.test(txt), `Personal absolute path: ${rel}`)
}
console.log(`Release source checks passed: ${files.length} allowlisted-source files; no private runtime directories, local configs or detected credentials.`)
console.log('Heuristic scan is not a guarantee; review git diff and npm pack --dry-run before publishing.')
