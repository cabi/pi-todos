pi-todos
Copyright 2026 cabi

This product is a derivative work of the `todos` extension
(extensions/todos.ts) from the `agent-stuff` repository
(https://github.com/mitsuhiko/agent-stuff), Copyright Armin Ronacher,
licensed under the Apache License, Version 2.0.

Changes relative to the original (7 measured development generations):
lean prompt surface (description, promptSnippet, "3+ steps" guideline,
compact list serialization, slim mutation echo, status enum),
session_compact re-injection of open todos, session claim/release
assignment, pid-based write locking with dead-lock stealing, garbage
collection of todos closed > 30 days (closed_at timestamps), and
single-flight auto-promotion on close. See CHANGELOG.md and
docs/BENCHMARK.md for details.
