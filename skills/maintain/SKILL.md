# Maintain Skill

Periodic brain health checks and cleanup.

## Workflow

1. **Run health check.** Check gbrain health to get the dashboard.
2. **Check each dimension:**

### Stale pages
Pages where compiled_truth is older than the latest timeline entry. The assessment hasn't been updated to reflect recent evidence.
- Check the health output for stale page count
- For each stale page: read the page from gbrain, review timeline, determine if compiled_truth needs rewriting

### Orphan pages
Pages with zero inbound links. Nobody references them.
- Review orphans: are they genuinely isolated or just missing links?
- Add links in gbrain from related pages or flag for deletion

### Dead links
Links pointing to pages that don't exist.
- Remove dead links in gbrain

### Missing cross-references
Pages that mention entity names but don't have formal links.
- Read compiled_truth from gbrain, extract entity mentions, create links in gbrain

### Tag consistency
Inconsistent tagging (e.g., "vc" vs "venture-capital", "ai" vs "artificial-intelligence").
- Standardize to the most common variant using gbrain tag operations

### Embedding freshness
Chunks without embeddings, or chunks embedded with an old model.
- For large embedding refreshes (>1000 chunks), use nohup:
  `nohup gbrain embed refresh > /tmp/gbrain-embed.log 2>&1 &`
- Then check progress: `tail -1 /tmp/gbrain-embed.log`

### Security (RLS verification)
Run `gbrain doctor --json` and check the RLS status.
All tables should show RLS enabled. If not, run `gbrain init` again.

### Schema health
Check that the schema version is up to date. `gbrain doctor --json` reports
the current version vs expected. If behind, `gbrain init` runs migrations
automatically.

### Open threads
Timeline items older than 30 days with unresolved action items.
- Flag for review

## Quality Rules

- Never delete pages without confirmation
- Log all changes via timeline entries
- Check gbrain health before and after to show improvement

## Tools Used

- Check gbrain health (get_health)
- List pages in gbrain with filters (list_pages)
- Read a page from gbrain (get_page)
- Check backlinks in gbrain (get_backlinks)
- Link entities in gbrain (add_link)
- Remove links in gbrain (remove_link)
- Tag a page in gbrain (add_tag)
- Remove a tag in gbrain (remove_tag)
- View timeline in gbrain (get_timeline)
