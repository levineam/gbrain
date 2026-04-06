# Install GBrain

Set up GBrain from scratch. The agent drives the process, the human provides secrets and approvals.

## Prerequisites

- A Supabase account (Pro tier recommended: $25/mo for 8GB DB + 100GB storage)
- An OpenAI API key (for semantic search embeddings, ~$4-5 for 7,500 pages)
- A git-backed markdown knowledge base (or start fresh)

## Phase 1: Environment Discovery

Scan the environment to understand what we're working with.

```bash
# Find all git repos with markdown content
echo "=== GBrain Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* 2>/dev/null; do
  if [ -d "$dir/.git" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      binary_count=$(find "$dir" -not -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" -type f \( -name "*.jpg" -o -name "*.png" -o -name "*.pdf" -o -name "*.mp4" -o -name "*.m4a" -o -name "*.heic" -o -name "*.tiff" -o -name "*.dng" \) 2>/dev/null | wc -l | tr -d ' ')
      echo ""
      echo "  $dir ($total_size, $md_count .md files, $binary_count binary files)"
      # Detect knowledge base type
      if [ -d "$dir/.obsidian" ]; then
        echo "    Type: Obsidian vault (detected, wikilink conversion needed in future release)"
      elif [ -d "$dir/logseq" ]; then
        echo "    Type: Logseq (detected, block-ref conversion needed in future release)"
      else
        echo "    Type: Plain markdown (ready for import)"
      fi
    fi
  fi
done
echo ""
echo "=== Discovery Complete ==="
```

Present findings to the human. Recommend which repos to import.

## Phase 2: Supabase Setup

### Magic Path (zero copy-pastes)

Check if the Supabase CLI is available:

```bash
which supabase 2>/dev/null || npx supabase --version 2>/dev/null
```

If available, use the magic path:

1. Tell the human: "I'll set up Supabase for you. Click 'Authorize' when your browser opens."
2. Run `supabase login` (opens browser for OAuth)
3. Run `supabase projects create --name gbrain --region us-east-1`
4. Extract credentials from `supabase projects api-keys`
5. Proceed to Phase 3 automatically

### Fallback Path (2 copy-pastes)

If the Supabase CLI is not available, tell the human exactly what to do:

1. "Log into Supabase and add a credit card: https://supabase.com/dashboard/account/billing"
2. "Create a new project: https://supabase.com/dashboard/new/_"
   - Name: gbrain
   - Region: closest to you
   - Generate a strong password
3. "Go to Project Settings > Database and copy the connection string (URI format)"
   - Paste it here
4. "Go to Project Settings > API and copy the service_role key"
   - Paste it here

That's it. Two copy-pastes. The agent does everything else.

## Phase 3: Initialize GBrain

```bash
gbrain init \
  --url "<database_url>" \
  --repo "<repo_path>"
```

This runs:
1. Connection test (SELECT 1)
2. pgvector extension check (CREATE EXTENSION IF NOT EXISTS vector)
3. Schema migration (idempotent, safe to re-run)
4. Text import (all .md files, no embeddings yet)
5. Sync checkpoint (writes git HEAD for seamless gbrain sync)

### First Search Result

After import completes, run a sample query to prove it works:

```bash
# Query the most recently modified page's topic
gbrain query "$(ls -t <repo_path>/*.md <repo_path>/**/*.md 2>/dev/null | head -1 | xargs head -5 | grep -i 'title:' | cut -d: -f2 | tr -d ' ')"
```

Show results to the human immediately. This is the magic moment.

### Start Embeddings

```bash
gbrain embed --stale &
```

Embeddings run in background. Keyword search works NOW. Semantic search improves as embeddings complete. Check progress with `gbrain embed --status`.

## Phase 4: Set Up Ongoing Sync

```bash
# Add to cron (every 5 minutes)
(crontab -l 2>/dev/null; echo "*/5 * * * * gbrain sync --no-pull 2>&1 | tail -1 >> /tmp/gbrain-sync.log") | crontab -
```

Or for agents that push to the brain repo, trigger sync after writes:
```bash
gbrain sync --no-pull
```

## Phase 5: Optional File Migration

If the repo has >100MB of binary files:

1. **Tell the human what will happen:**
   "Your repo has X binary files (Y MB). I can move them to Supabase Storage to slim down git. Files stay in git history permanently. Want me to proceed?"

2. **If approved:**
   ```bash
   gbrain health                              # verify everything is connected
   gbrain files sync <repo>/attachments/      # upload all files
   gbrain files verify                        # mandatory 100% verification
   # STOP: ask human for approval before git rm
   ```

3. **After human approves git rm:**
   ```bash
   cd <repo>
   echo "attachments/" >> .gitignore
   git rm -r --cached attachments/
   git commit -m "Move attachments to Supabase Storage"
   git push
   ```

## Phase 6: Teach the Agent

Add GBrain rules to AGENTS.md (or equivalent):

```markdown
## GBrain (Knowledge Search)

GBrain indexes your knowledge base for fast search. Always search before answering
questions about people, companies, deals, or anything in the brain.

### Commands
- `gbrain query "search terms"` -- Search the knowledge base (keyword + semantic)
- `gbrain sync` -- Sync latest changes from git to GBrain
- `gbrain files upload <path> --page <slug>` -- Upload a file to storage
- `gbrain health` -- Check GBrain status
- `gbrain stats` -- Show page count, embedding coverage, last sync

### Rules
1. **Search the brain first.** Before answering any question about people, companies,
   deals, meetings, or strategy, run `gbrain query`. Your memory of file contents
   goes stale; the database doesn't.
2. **Never commit binaries to git.** Use `gbrain files upload` instead.
3. **After writing to the brain repo,** trigger `gbrain sync --no-pull` to update
   the search index immediately.
```

## Error Handling

Every error tells you what happened, why, and how to fix it:

| What You See | Why | Fix |
|---|---|---|
| Connection refused | Supabase project paused or wrong URL | supabase.com/dashboard > Restore |
| Password authentication failed | Wrong password | Project Settings > Database > Reset password |
| pgvector not available | Extension not enabled | Run CREATE EXTENSION vector in SQL Editor |
| OpenAI key invalid | Expired or wrong key | platform.openai.com/api-keys > Create new |
| Sync anchor missing | Force push removed the commit | `gbrain sync --full` |
| No pages found | Query before import | `gbrain import <dir>` first |

## Upgrading

Upgrade depends on how you installed:
- **bun (standalone or library):** `bun update gbrain`
- **ClawHub:** `clawhub update gbrain`
- **Compiled binary:** Download the latest from [GitHub Releases](https://github.com/garrytan/gbrain/releases)

After upgrading:
- Run `gbrain init` again to apply schema migrations (idempotent, safe to re-run)
- The new `files` table gets created automatically on next init
- Sync state is preserved across upgrades

## Health Check

Run `gbrain health` at any time to verify all connections:

```
ok Database: connected
ok pgvector: extension loaded
ok Schema: up to date
ok Sync: last run N min ago
ok Embeddings: X/Y pages embedded
```

Every unhealthy line includes WHY and FIX.
