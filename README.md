# Global News Wire

A serverless international news site with no AI and no API keys. Every three hours a GitHub Actions workflow fetches RSS feeds, cleans the text with plain code, commits the result to `data.json`, and publishes the site to GitHub Pages.

```
.
├── .github/workflows/update-news.yml   # fetch → commit → deploy, every 3 hours
├── cron-pipeline.js                    # fetch → clean → dedupe → data.json
├── data.json                           # public archive (100 newest)
├── index.html                          # frontend
├── package.json
└── .gitignore
```

## Setup (about 10 minutes)

### 1. Create an empty repository

On GitHub: **+ (top right) → New repository**.
- Name it, for example `global-news-wire`.
- Set it to **Public**. GitHub Pages on a private repo needs a paid plan.
- Do **not** tick "Add a README", .gitignore or licence. The repo must be empty.
- Click **Create repository**.

### 2. Upload the code

**Option A: command line** (from inside the unzipped `global-news-wire` folder):

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/global-news-wire.git
git push -u origin main
```

**Option B: GitHub Desktop.** Use File → Add local repository, choose the folder, create the repository when prompted, then Publish.

Avoid the browser's "upload files" page. It often drops the hidden `.github` folder, and without that folder nothing runs.

### 3. Allow the workflow to push commits

**Settings → Actions → General → Workflow permissions** → choose **Read and write permissions** → **Save**.

### 4. Set the Pages source to GitHub Actions

**Settings → Pages → Build and deployment → Source** → choose **GitHub Actions**.

Do not choose "Deploy from a branch". Commits made by the workflow bot do not trigger a branch-based Pages build, so with that setting the site would never refresh.

### 5. Run it once

**Actions tab** → if a banner asks, click **I understand my workflows, go ahead and enable them** → **Update News** (left) → **Run workflow** → **Run workflow**.

Both jobs (`update`, `deploy`) should turn green in 1–2 minutes. The `deploy` job shows the site URL, normally `https://<your-username>.github.io/global-news-wire/`. If your account already has a custom domain on its `<username>.github.io` site, the new site appears under that domain instead, at `/global-news-wire/`.

From then on it runs every three hours, and also each time you push a change.

## Checking it worked

- Open the `update` job log and look at the **Run news pipeline** step. It lists each feed with an item count. A line such as `Feed failed: Al Jazeera -> Status code 403` means that site blocked the GitHub runner. The other feeds still work, so you can remove that entry or replace it.
- `data.json` in the repo should now contain articles, committed by `github-actions[bot]`.

## Changing feeds

Edit the `FEEDS` array in `cron-pipeline.js`. Each entry needs a `name`, a `url`, and one `category` from: World, Technology, Economy, Science, Health. Push the change and the site rebuilds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `git push` fails with 403 in the update job | Step 3 not saved |
| Deploy job fails with "Pages not enabled" or "environment protection" | Step 4 not set to GitHub Actions |
| Site shows "No stories yet" | Workflow has not run yet, or every feed failed (check the log) |
| Updates stopped after a couple of months | GitHub pauses scheduled workflows in public repos after 60 days with no repo activity. Re-enable from the Actions tab, or push any small change |

## Known limits

- Headlines keep the publisher's wording. The code removes obvious teasers but cannot judge tone.
- Categories come from the feed, so a health story in the BBC World feed is labelled World.
- The Reuters entry is a Google News search. Its links pass through news.google.com, and its cards show a headline only.
- GitHub's scheduler is best effort. Runs can start 10–30 minutes late.
- Check each publisher's RSS terms before any commercial use.
