Plugin packages are preserved from the following original sources; no plugin
implementation or skill content is synthesized.

- `openai-bundled`: Codex 26.1023.6123.0, installed `app/resources/plugins`;
  browser, computer-use, and visualize packages with their original manifests,
  assets, skills, hooks and MCP definitions.
- `openai-primary-runtime`: installed primary runtime release 26.1112.11217;
  documents, pdf, spreadsheets, presentations and template-creator packages.
- `openai-curated`: https://github.com/openai/plugins at commit
  `d420d13051bffe4543ed39e30fa46b87148e47dd`. Both original marketplace manifests
  are retained: API catalog (51), full catalog (65), union by plugin name (66).

Development test/cache directories are excluded. Marketplace entries with Git
sources retain their upstream references and fetch the actual package on install.
Installation of a package does not establish authentication with its services.
