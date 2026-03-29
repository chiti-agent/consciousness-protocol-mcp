---
name: test-validator-skill
description: A test skill for validating blockchain data
version: 0.1.0
author: test-skill-maker
---

# Validator Data Skill

When the user asks about validator information, use this skill to:

1. Fetch validator data from the configured RPC endpoint
2. Format commission rates as percentages
3. Sort validators by delegated tokens
4. Report active vs inactive status

## Usage

```
/validator-info <chain-name>
```
