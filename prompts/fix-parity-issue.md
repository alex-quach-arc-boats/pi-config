---
description: Investigate and fix an SLX to Rust parity issue
argument-hint: "[description of the parity gap]"
---
Parity issue: ${@:-described in the conversation}

Standing rules for every fix:

- SLX-to-Rust file parity is the most important concern. The Rust code for each SLX subsystem must live in the same Rust file that corresponds to that SLX subsystem. Use the SLX model to determine file placement.
- The C implementation is only a reference for semantic equality. Compare behavior against C, but never let C's file or module structure influence where Rust code lives.
- Do not review your own work. Limit your own effort to orchestration and implementation, and spawn reviewer subagents to verify the parity of any change.

Work through it in this order:

1. Reproduce the divergence and pin down the exact behavioral difference. State which inputs produce which outputs on each side.
2. Locate the corresponding SLX subsystem and confirm the Rust code for it sits in the same-file location the SLX structure dictates.
3. Read the SLX subsystem semantics, and use the C code only to confirm semantic equality of the behavior.
4. Fix the incorrect side.

If the report is too vague to reproduce, ask for the missing details instead of guessing.
