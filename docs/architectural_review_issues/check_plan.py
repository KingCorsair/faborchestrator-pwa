"""Consistency checks for PWA_ARCHITECTURAL_REMEDIATION_PLAN.md.

Usage: python docs/architectural_review_issues/check_plan.py docs/architectural_review_issues/PWA_ARCHITECTURAL_REMEDIATION_PLAN.md

Checks: every review finding (50) and G-finding owned exactly once; the section 2 summary
equals the section 8 matrix; dependency edges equal the summary; the graph is acyclic;
every RP and CP section exists. Exit code 1 on any failure. Documentation tooling only.
"""
import re,sys
t=open(sys.argv[1],encoding='utf-8').read()
ok=True
def fail(m):
    global ok; ok=False; print("FAIL:",m)
RPS=['RP0','RP1','RP2','RP3','RP4','RP5','RP6','RP7','RP8','RP9','RP10-A','RP10-B']
cell=lambda l:[c.strip() for c in l.strip().strip('|').split('|')]
m81=t.split('### 8.1')[1].split('### 8.2')[0]
rows=[cell(l) for l in m81.splitlines() if re.match(r'^\| (B|M|m|N)\d+ \|',l)]
exp=[f'B{i}' for i in range(1,6)]+[f'M{i}' for i in range(1,19)]+[f'm{i}' for i in range(1,20)]+[f'N{i}' for i in range(1,9)]
ids=[r[0] for r in rows]
if sorted(ids)!=sorted(exp) or len(ids)!=len(set(ids)): fail(f"8.1 ids missing={set(exp)-set(ids)}")
m82=t.split('### 8.2')[1].split('\n## ')[0]
grows=[cell(l) for l in m82.splitlines() if re.match(r'^\| G\d+ \|',l)]
gids=[r[0] for r in grows]
if gids!=[f'G{i}' for i in range(1,34)]: fail(f"G ids {gids}")
own={}
for r in rows: own.setdefault(r[5],set()).add(r[0])
for r in grows: own.setdefault(r[4],set()).add(r[0])
for k in own:
    if k not in RPS: fail(f"unknown owner {k}")
summ=t.split('## 2. Roadmap summary')[1].split('\n## 3.')[0]
deps={}
for l in summ.splitlines():
    m=re.match(r'^\| \*\*(RP[\w-]+)\*\* \|',l)
    if not m: continue
    c=cell(l); rp=m.group(1)
    listed=set(re.findall(r'\b([BMmNG]\d{1,2})\b',c[2]))
    if listed!=own.get(rp,set()): fail(f"{rp} summary != matrix")
    deps[rp]=set(re.findall(r'RP\d+(?:-[AB])?',c[3]))
if set(deps)!=set(RPS): fail("summary rows")
ct=t.split('**Count:**')[1].split('### 8.2')[0]
for l in ct.splitlines():
    m=re.match(r'^\| (RP[\w-]+) \| (\d+) \|',l)
    if m and len([i for i in own.get(m.group(1),set()) if not i.startswith('G')])!=int(m.group(2)): fail(f"count {m.group(1)}")
et=t.split('**Why each dependency edge exists:**')[1].split('The graph is acyclic')[0]
edges=set()
for l in et.splitlines():
    if not l.startswith('| RP'): continue
    e=cell(l)[0]
    if e.startswith('RP7 ⇢'): continue
    m=re.match(r'^(.*?)\s*(?:→|⇢)\s*(.*)$',e)
    for s in re.findall(r'RP\d+(?:-[AB])?',m.group(1)):
        for d in re.findall(r'RP\d+(?:-[AB])?',m.group(2)): edges.add((s,d))
fromsumm={(d,rp) for rp,ds in deps.items() for d in ds}
if fromsumm-edges: fail(f"summary deps missing from edge table: {sorted(fromsumm-edges)}")
if edges-fromsumm: fail(f"edge table edges not in summary: {sorted(edges-fromsumm)}")
g={r:set() for r in RPS}
for s,d in edges: g[s].add(d)
seen,stack=set(),set()
def dfs(u):
    stack.add(u)
    for v in g[u]:
        if v in stack: fail(f"cycle {u}->{v}")
        elif v not in seen: dfs(v)
    stack.discard(u); seen.add(u)
for r in RPS:
    if r not in seen: dfs(r)
for r in RPS:
    if not re.search(rf'^### {re.escape(r)} — ',t,re.M): fail(f"no section {r}")
for c in range(6):
    if not re.search(rf'^### CP{c} — ',t,re.M): fail(f"no CP{c}")
bad=sorted(set(re.findall(r'\bRP\d+(?:-[AB])?',t))-set(RPS)-{'RP10'})
if bad: fail(f"unknown packages {bad}")
import sys as _s
print(f"review rows {len(rows)}/50 | G rows {len(grows)}/33 | packages {len(deps)} | edges {len(edges)} | result: {'PASS' if ok else 'FAIL'}")
_s.exit(0 if ok else 1)
