# convert-280blocker-domain

Convert the [280blocker domain list](https://280blocker.net/download/) into CSV files for Cloudflare Gateway.

This is an unofficial conversion tool, not an original blocklist or an official 280blocker or Cloudflare project. Upstream lists and generated data are not included in this repository.

## Requirements

- Node.js 24. No npm dependencies are required.
- HTTPS access to `280blocker.net`.

## Usage

```sh
git clone https://github.com/owner203/convert-280blocker-domain.git
cd convert-280blocker-domain
node convert-280blocker-domain.mjs
```

Each run downloads `280blocker_domain_YYYYMM.txt` for the current month in the `Asia/Tokyo` time zone. Existing local TXT files are not used, and a failed download does not fall back to an earlier month.

By default, output is written to `cloudflare-280blocker-domain-YYYYMM/` in the current working directory. Pass an optional output directory as the first argument:

```sh
node convert-280blocker-domain.mjs ./output
```

## Output

```text
cloudflare-280blocker-domain-YYYYMM/
  280blocker_domain_YYYYMM_cloudflare_001.csv
  280blocker_domain_YYYYMM_cloudflare_002.csv
  ...
  conversion-report.json
```

- CSV files contain a `value` header and up to 999 unique domains each: at most 1,000 rows including the header.
- Domains are normalized to lowercase ASCII and deduplicated. Comments, blank lines, and IP addresses are skipped; other invalid entries cause the conversion to fail.
- The source header, update date, minimum domain count, and expected upstream test domains are checked before output is written.
- `conversion-report.json` records the source URL, update date, download SHA-256, skipped entries, and per-file counts. The same report is printed to standard output.

Use a dedicated output directory. Re-running overwrites the report and matching CSV files, and removes surplus CSV chunks for the same source month. Files for other months are not removed.

## Import into Cloudflare Gateway

1. In Cloudflare Zero Trust, open **Reusable components > Lists** and choose **Upload CSV**.
2. Import each generated CSV as a separate **Domain** list (`DOMAIN`).
3. Create a DNS policy with action **Block** and a **Domain / in list** condition for each imported list, joining the conditions with **OR**.

Use the **Domain** selector, not **Host**: Domain also matches subdomains, as required by the upstream list. Clients must send their DNS queries through the configured Gateway for the policy to apply.

The script only creates local files. It does not upload lists, create policies, or update existing Cloudflare configuration. Re-run it and manually refresh the imported lists when updating the rules.

See Cloudflare's [list documentation](https://developers.cloudflare.com/cloudflare-one/reusable-components/lists/) and [DNS policy documentation](https://developers.cloudflare.com/cloudflare-one/traffic-policies/dns-policies/#domain) for details and current limits.

## Upstream data terms

280blocker's [download page](https://280blocker.net/download/) limits the distributed filter files to personal use permitted by copyright law and prohibits commercial use and redistribution. Check the upstream terms before downloading or using the data.

Keep downloaded TXT files and generated CSV files private. Do not publish them in this repository, releases, or public build artifacts. `.gitignore` excludes upstream TXT files, default output directories, and generated CSV/report filenames, including those in custom output directories.
