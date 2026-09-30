# What I recommend to Jothi

Short enough to say out loud.

---

**What should we build first?**

A generic agent host inside the PWA. Today an agent is code; we make it a
description — endpoint, whether it keeps history, whether it takes tools,
whether it has files, what permission it needs. One screen and one proxy read
that description. About a week, and it needs nothing from the FabOrchestrator
team.

**What is the long-term target?**

One FabOrchestrator endpoint that owns agent selection, permissions, tools,
history and streaming — plus a discovery endpoint so the app can show what
exists without being redeployed. That does not exist today: `/api/orchestrate`
and `/api/agents` both return 404. When FO builds it, the host we are building
becomes its client. Nothing is wasted.

**Why isn't embedding FabOrchestrator the answer on its own?**

We tested it. FabOrchestrator does frame — no headers block it. But its session
lives in browser storage that a framed page cannot share with us, so the user
would log in a second time, inside the frame, and on iPhone that second session
gets evicted. Embedding also gives up the things that make it a phone app: the
offline screen, the conversation drawer, the mobile layout. It answers "how do
new FO screens appear" and breaks "is this a good app on a phone".

If we ever do embed, the only version worth building is serving FO through our
own domain, so there is one origin and one login. That is a real project, and I
have a package that tests it on a real iPhone before anyone commits.

**How does this stop us rebuilding for every new agent?**

Today a new agent costs a page, a proxy contract, a screen and a test suite —
half a day to two days. After this, a conversational agent costs a config block,
under an hour. An agent with something genuinely new, like file upload, costs
one adapter behind a flag.

That is not theoretical. FabOrchestrator has already written a Back-end Agent
with its own prompt and tools — it just isn't deployed yet. The day it ships,
today's architecture needs work and the new one needs a line.

**What would FO have to change to make this much cleaner?**

Six things, in rough order: one `/api/orchestrate` entry point; a `/api/agents`
discovery endpoint; server-side agent selection; one way of answering "may this
user use this agent" instead of a gate per agent; one artifact and file contract
across agents; and versioning. I'll write that up for their team — it is a
request, not something we do to them.

**What can we demonstrate first?**

Two demos, two weeks.

*Week one:* the app looks and behaves exactly as it does now — same answers,
same history, same everything — but FabInsight is running through the generic
host. The proof is that every existing check passes unchanged.

*Week two:* the Modeling Agent's conversations open in the PWA, on the same
screen, through the same proxy — a different endpoint, a different request
shape, a different history bucket and a role check. Side by side with FabInsight
on one phone, and the diff that added it is a block of configuration.

Then, in front of you, I add a third agent in under an hour and delete it again.

---

**One caveat worth saying plainly.** I'd start this after Monday's demo, not
before. The current path works and the first milestone's whole gate is that it
keeps working.
