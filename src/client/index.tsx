/**
 * dsh-pack-maker client: registers the "整合包 / Packs" settings section with
 * export and import flows. Talks to the host through the /dsh-pack/* routes
 * served by the same origin.
 *
 * Built by scripts/build-client.mjs into the __ModuleLoader__ factory bundle.
 */
import React from 'react';
import { zh, en } from './locales';

const NS = 'dsh-pack-maker';

export const name = 'dsh-pack-maker';
export const inject = ['slots', 'locale'];

const cardStyle = {
  border: '1px solid var(--dsh-color-border, rgba(128,128,128,0.35))',
  borderRadius: 8,
  padding: '14px 16px',
  marginTop: 12,
};
const titleStyle = { margin: 0, fontSize: 15, fontWeight: 600 };
const hintStyle = { margin: '4px 0 0', fontSize: 13, opacity: 0.7 };
const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' };
const labelStyle = { fontSize: 13 };
const buttonStyle = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid rgba(128,128,128,0.45)',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 13,
};
const primaryStyle = {
  ...buttonStyle,
  background: 'var(--dsh-color-accent, #4f6ef2)',
  borderColor: 'transparent',
  color: '#fff',
};
const errorStyle = { color: '#d64545', fontSize: 13, marginTop: 8 };
const okStyle = { color: '#2e9e5b', fontSize: 13, marginTop: 8 };
const chipStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  margin: '2px 4px 2px 0',
  borderRadius: 10,
  fontSize: 12,
  border: '1px solid rgba(128,128,128,0.4)',
};

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function PackMakerSection({ t }) {
  const [profiles, setProfiles] = React.useState([]);
  const [profile, setProfile] = React.useState('');
  const [includeVendor, setIncludeVendor] = React.useState(true);
  const [includeLockfile, setIncludeLockfile] = React.useState(true);
  const [exporting, setExporting] = React.useState(false);
  const [exportResult, setExportResult] = React.useState(null);
  const [error, setError] = React.useState('');

  const [fileName, setFileName] = React.useState('');
  const fileRef = React.useRef(null);
  const [preview, setPreview] = React.useState(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [targetProfile, setTargetProfile] = React.useState('');
  const [overwrite, setOverwrite] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState(null);

  React.useEffect(() => {
    fetch('/dsh-pack/profiles', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => {
        if (body?.ok && Array.isArray(body.profiles)) {
          setProfiles(body.profiles);
          setProfile((current) => current || body.profiles[0] || '');
        }
      })
      .catch(() => {});
  }, []);

  async function doExport() {
    setError('');
    setExportResult(null);
    setExporting(true);
    try {
      const body = await postJson('/dsh-pack/export', { profile, includeVendor, includeLockfile });
      if (!body?.ok) throw new Error(body?.error || 'export failed');
      setExportResult(body);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setExporting(false);
    }
  }

  async function pickFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    fileRef.current = file;
    setFileName(file.name);
    setPreview(null);
    setImportResult(null);
    setError('');
    setPreviewing(true);
    try {
      const res = await fetch('/dsh-pack/preview', { method: 'POST', body: file });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.error || 'preview failed');
      setPreview(body.summary);
      setTargetProfile(body.summary?.meta?.name ?? '');
    } catch (cause) {
      setError(`${t('previewFail')}: ${String(cause instanceof Error ? cause.message : cause)}`);
    } finally {
      setPreviewing(false);
    }
  }

  async function doImport() {
    const file = fileRef.current;
    if (!file) return;
    setError('');
    setImportResult(null);
    setImporting(true);
    try {
      const query = new URLSearchParams({ profileName: targetProfile, overwrite: String(overwrite) });
      const res = await fetch(`/dsh-pack/import?${query.toString()}`, { method: 'POST', body: file });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.error || 'import failed');
      setImportResult(body.result);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setImporting(false);
    }
  }

  const bundles = preview?.bundles ?? [];
  const dependencies = preview?.dependencies ?? {};

  return React.createElement(
    'div',
    { style: { padding: '2px 0 8px' } },
    React.createElement('p', { style: hintStyle }, t('subtitle')),

    // ---- Export card ----
    React.createElement(
      'div',
      { style: cardStyle },
      React.createElement('h3', { style: titleStyle }, t('exportTitle')),
      React.createElement('p', { style: hintStyle }, t('exportHint')),
      React.createElement(
        'div',
        { style: rowStyle },
        React.createElement('label', { style: labelStyle }, t('profile')),
        React.createElement(
          'select',
          { value: profile, onChange: (e) => setProfile(e.target.value), style: { padding: '4px 8px' } },
          profiles.map((name) => React.createElement('option', { key: name, value: name }, name)),
        ),
      ),
      React.createElement(
        'div',
        { style: rowStyle },
        React.createElement('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 } },
          React.createElement('input', { type: 'checkbox', checked: includeVendor, onChange: (e) => setIncludeVendor(e.target.checked) }),
          t('includeVendor'),
        ),
        React.createElement('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 } },
          React.createElement('input', { type: 'checkbox', checked: includeLockfile, onChange: (e) => setIncludeLockfile(e.target.checked) }),
          t('includeLockfile'),
        ),
      ),
      React.createElement(
        'div',
        { style: rowStyle },
        React.createElement(
          'button',
          { onClick: doExport, disabled: exporting || !profile, style: primaryStyle },
          exporting ? t('exporting') : t('export'),
        ),
      ),
      exportResult &&
        React.createElement(
          'div',
          { style: okStyle },
          `${t('exportDone')}: ${exportResult.outputPath} (${exportResult.bytes} bytes)`,
          ' ',
          React.createElement(
            'a',
            { href: `/dsh-pack/download?token=${encodeURIComponent(exportResult.token)}`, style: { color: 'inherit' } },
            t('download'),
          ),
        ),
    ),

    // ---- Import card ----
    React.createElement(
      'div',
      { style: cardStyle },
      React.createElement('h3', { style: titleStyle }, t('importTitle')),
      React.createElement('p', { style: hintStyle }, t('importHint')),
      React.createElement(
        'div',
        { style: rowStyle },
        React.createElement('input', { ref: fileRef, type: 'file', accept: '.dshpack', onChange: pickFile, style: { fontSize: 13 } }),
        React.createElement('span', { style: labelStyle }, fileName ? `${fileName} · ${previewing ? t('previewing') : ''}` : t('noFile')),
      ),
      preview &&
        React.createElement(
          'div',
          { style: { marginTop: 10, fontSize: 13 } },
          React.createElement('div', null, `${t('packName')}: ${preview.meta?.name ?? '?'}${preview.meta?.title ? ` — ${preview.meta.title}` : ''}`),
          preview.meta?.description && React.createElement('div', null, preview.meta.description),
          preview.meta?.createdAt && React.createElement('div', { style: hintStyle }, `${t('packCreated')}: ${new Date(preview.meta.createdAt).toLocaleString()}`),
          React.createElement('div', { style: { marginTop: 6 } },
            t('packBundles'),
            bundles.length === 0
              ? React.createElement('span', { style: hintStyle }, ' —')
              : bundles.map((bundle) => React.createElement('span', { key: bundle, style: chipStyle }, bundle)),
          ),
          Object.keys(dependencies).length > 0 &&
            React.createElement('div', { style: { marginTop: 4 } },
              t('packDeps'),
              Object.entries(dependencies).map(([dep, spec]) =>
                React.createElement('span', { key: dep, style: chipStyle }, `${dep}@${spec}`)),
            ),
        ),
      preview &&
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('label', { style: labelStyle }, t('targetProfile')),
          React.createElement('input', {
            value: targetProfile,
            onChange: (e) => setTargetProfile(e.target.value),
            style: { padding: '4px 8px' },
          }),
        ),
      preview &&
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('label', { style: { ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 } },
            React.createElement('input', { type: 'checkbox', checked: overwrite, onChange: (e) => setOverwrite(e.target.checked) }),
            t('overwrite'),
          ),
        ),
      preview &&
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement(
            'button',
            { onClick: doImport, disabled: importing || !targetProfile, style: primaryStyle },
            importing ? t('importing') : t('import'),
          ),
        ),
      importResult &&
        React.createElement('div', { style: okStyle },
          `${t('importDone')}: ${importResult.profile} → ${importResult.dir}`,
          importResult.install?.ok === false && !importResult.install?.skipped
            ? ` · ${t('importWarnInstall')}`
            : null,
        ),
    ),

    error && React.createElement('div', { style: errorStyle }, `${t('error')}: ${error}`),
    React.createElement(MarketCard, { t }),
  );
}

function MarketCard({ t }) {
  const [items, setItems] = React.useState([]);
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState(null);

  async function load(query) {
    setError(''); setPreview(null); setImportResult(null); setLoading(true);
    try {
      const res = await fetch(`/dsh-pack/market?query=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.error || 'market failed');
      setItems(body.items ?? []);
      if (body.errors?.length) setError(body.errors.map((entry) => entry.message).join('; '));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { load(''); }, []);

  async function previewItem(item) {
    setError(''); setPreview(null); setImportResult(null);
    try {
      const res = await fetch('/dsh-pack/market/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: item.source, path: item.path, url: item.url }),
      });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.error || 'preview failed');
      setPreview({ item, summary: body.summary });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }

  async function importItem(item) {
    setError(''); setImportResult(null); setImporting(true);
    try {
      const params = new URLSearchParams({ profileName: item.name, overwrite: 'false' });
      const res = await fetch(`/dsh-pack/market/import?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: item.source, path: item.path, url: item.url }),
      });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.error || 'import failed');
      setImportResult(body.result);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setImporting(false);
    }
  }

  return React.createElement(
    'div',
    { style: cardStyle },
    React.createElement('h3', { style: titleStyle }, t('marketTitle')),
    React.createElement('p', { style: hintStyle }, t('marketHint')),
    React.createElement(
      'div',
      { style: rowStyle },
      React.createElement('input', {
        value: query,
        onChange: (e) => setQuery(e.target.value),
        placeholder: t('marketSearch'),
        style: { flex: 1, padding: '4px 8px', fontSize: 13 },
      }),
      React.createElement('button', { onClick: () => load(query), disabled: loading, style: buttonStyle }, t('marketSearchBtn')),
    ),
    loading && React.createElement('p', { style: hintStyle }, t('marketLoading')),
    error && React.createElement('div', { style: errorStyle }, error),
    !loading && items.length === 0 && React.createElement('p', { style: hintStyle }, t('marketEmpty')),
    items.map((item) =>
      React.createElement(
        'div',
        { key: `${item.source}:${item.name}`, style: { marginTop: 8, fontSize: 13 } },
        React.createElement('div', null,
          `${item.name}${item.title && item.title !== item.name ? ` — ${item.title}` : ''} [${item.source}]${item.version && item.version !== 'unknown' ? ` v${item.version}` : ''}`),
        item.description && React.createElement('div', { style: hintStyle }, item.description),
        React.createElement(
          'div',
          { style: rowStyle },
          React.createElement('button', { onClick: () => previewItem(item), style: buttonStyle }, t('marketPreview')),
          React.createElement(
            'button',
            { onClick: () => importItem(item), disabled: importing, style: primaryStyle },
            importing ? t('importing') : t('marketImport'),
          ),
        ),
      ),
    ),
    preview && React.createElement('div', { style: { marginTop: 10, fontSize: 13 } },
      `${t('packBundles')}: ${preview.summary?.bundles?.length ?? 0}`,
      Object.keys(preview.summary?.dependencies ?? {}).length > 0
        ? ` · ${t('packDeps')}: ${Object.entries(preview.summary?.dependencies ?? {}).map(([dep, spec]) => `${dep}@${spec}`).join(', ')}`
        : null,
    ),
    importResult && React.createElement('div', { style: okStyle }, `${importResult.profile} → ${importResult.dir}`),
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pack-maker: locales');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'pack-maker',
        order: 50,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      },
      () => React.createElement(PackMakerSection, { t }),
    ),
  );
}
