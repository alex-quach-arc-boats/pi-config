# quach-harness

An [opencode](https://opencode.ai) agent harness. It disables the built-in agents named in `opencode.json` and defines four custom agents that handle coordination, analysis, implementation, and review, and it ships a documentation skill that keeps agent prose tight.

## Agents and models

- `primary` on `opencode-go/gpt-6-luna` orchestrates and delegates to subagents.
- `deep-thinker` on `opencode/claude-opus-5.5` gives slow, complex analysis.
- `doer` on `opencode-go/glm-5.3-flash` implements one clearly bounded task.
- `reviewer` on `opencode/gpt-6-sol` reviews changes.

## How to use

Check out this repo, then add this to your shell (with the correct path):

```
export OPENCODE_CONFIG_DIR=/home/alex/github/quach-harness/.opencode
export OPENCODE_CONFIG=/home/alex/github/quach-harness/opencode.json
```

Opencode merges configs with what's in ~/.config/opencode, so anything there may still alter your experience. Clear out that directory of skills and agents if you want to only use what's here.

## Background jobs

`.opencode/tools/jobs.ts` adds two tools for running prompts as asynchronous, process-isolated jobs. `jobs_spawn` takes a prompt and starts a detached `opencode run` process, returning a job id immediately. `jobs_status` with no id lists the jobs spawned from the current directory, and with an id reports the job's state (running, succeeded, failed, or lost), its token usage and session id, and the text of its final answer. A failed job also reports its exit code, any provider error, and the tail of stderr.

Each job lives in its own directory under `~/.local/state/opencode-jobs/<id>/`, holding a write-once `job.json`, the prompt, the raw `--format json` event stream, stderr, and an `exit` file. State is derived from that directory rather than from a mutable status field, so a job whose wrapper dies without writing an exit code reads as lost rather than running forever. Jobs run with permissions auto-approved and explicit denies still enforced, they use the harness agents in whatever directory they were spawned from, and they refuse to spawn further jobs.

## Motivation

I've been using codebuff for over a year, but recently became dissatisfied with its performance when it moved its main models to Opus 5. When this happened, it cranked up the AI speak to 12/10, slowed down responses and caused extra overthinking, which wasted a lot of time.

Codebuff also seems more niche, so I felt less comfortable using it for the long term, especially as it falls behind other harnesses for things like session forking and moving sessions between directories. As such, I started looking for a new harness and settled on opencode as a good balance between batteries included and customizability.

For some reason, I'm more skeptical of the major ones like Codex and Claude Code because they vertically integrate with the models themselves. This probably leads to better performance because they probably spent a lot more time tuning them. However, it also feels like a conflict of interest because they want you to burn a lot of tokens, because that's how they make money.

### Non Anthropic/OpenAI models

After starting on opencode with just Opus 4.8, it burned quite a lot of money and was a bit slow. Some of the Chinese models, which codebuff used to use in its `lite` mode, were pretty strong, providing a nice balance between being fast, efficient, and smart. Using those cut down the cost by quite a bit. My favorite one, although I haven't used them all, is GLM 5.2.

### Delegation/subagents

Using that one gave pretty good results; however, I still wanted to optimize it a little more because having one agent do everything tends to pollute your context window. This, in turn, increases cost and time. Every time your agent does something or returns to you for more information, the entire context window is posted back to the agent, creating an N^2 situation where, if your agent is incredibly verbose and overthinks, it will spam the context window with extra thoughts that will get reposted to it over and over, taking up more time and dollars.

Sub-agents solve this by allowing agents to delegate, sort of like a function call, because the new agent gets an entirely fresh context window with only a little bit of context injected into it from the parent agent, like function arguments. After it finishes thinking, it returns only its conclusion back to the parent agent, thus protecting the parent agent's context. Another benefit is that the sub-agent can use a different model, which can be helpful if you want to do something with more or less thought than the standard parent model. 

The downside of sub-agents is that excessive calling of sub-agents slows down the overall work that gets done, in the same way that excessive delegation in human space slows down getting things done. It's important to only delegate when there are clear performance improvements or cost savings to be had. I tried [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim), a popular opencode plugin with several agents, and found that it was impressively cheap, but even simple PRs took 20 to 30 minutes. For the same performance, there's a time vs cost tradeoff. You could potentially have one model bang out a PR with zero delegation, which would be faster but more expensive.

### Time vs cost

The base cost of an engineer is so high that it's probably not worth it to try to squeeze every dollar trying to make your AI prompting as efficient as possible. However, it's still important to 80/20 so that you don't blow $100 on every small PR. The sweet spot is probably a little delegation, but not too much.

Time, aka latency, is also an interesting tradeoff, because it depends on how urgently you need the work to get done. If you're writing some big prompts to run overnight, it doesn't matter if it takes an hour or five because you'll be sleeping through it, and you can scale up throughput if you run multiple agents. 

However, the mindset of needing to come back later for even minor changes does increase friction, because it's nice to have AI handle a small PR in under five minutes, which doesn't require you to mentally classify it as a long-running background task. It may be less mental overhead to hash out five quick PRs in serial than figure out how to parallelize them all slowly.

## Summary

- Primary is GPT-6-Luna for coordination and delegation.
* Delegates to the Deep Thinker Opus 5.5 for stuff that you actually want to spend a lot of time analyzing.
* Delegates to the Doer GLM-5.3-Flash to protect the context window.
* Delegates to the Reviewer GPT-6-Sol for review.
