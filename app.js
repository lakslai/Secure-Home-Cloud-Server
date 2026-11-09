const $ = (id) => document.getElementById(id);
const config = window.CLOUD_CONFIG || {};
const BUCKET = 'home-files';
const MAX_FILE_BYTES = 50 * 1024 * 1024;

let supabase;
let currentUser;
let databaseUserId;
let storageId;
let files = [];
let registerMode = false;
let renameTarget = null;
let searchTimer;

function message(id, text, success = false) {
  const element = $(id);
  element.textContent = text;
  element.classList.toggle('success', success);
}

function friendlyError(error) {
  console.error(error);
  return error?.message || 'Something went wrong. Please try again.';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function category(file) {
  const type = file.file_type || '';
  const name = file.file_name.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.includes('pdf') || type.includes('document') || type.includes('text') || /\.(docx?|xlsx?|pptx?|pdf|txt)$/.test(name)) return 'document';
  return 'other';
}

function iconFor(file) {
  return { image: '▧', video: '▶', document: '▤', other: '◇' }[category(file)];
}

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'small-button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function renderFiles() {
  const tbody = $('fileRows');
  tbody.replaceChildren();
  const selectedType = $('typeFilter').value;
  const visible = files.filter((file) => selectedType === 'all' || category(file) === selectedType);
  $('emptyState').hidden = visible.length > 0;
  $('emptyState').textContent = $('searchInput').value || selectedType !== 'all'
    ? 'No files match your search.' : 'No files here yet. Upload your first file.';

  for (const file of visible) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'file-name';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = iconFor(file);
    const label = document.createElement('span');
    label.textContent = file.file_name;
    name.append(icon, label);
    nameCell.append(name);
    const typeCell = document.createElement('td');
    typeCell.textContent = category(file);
    const sizeCell = document.createElement('td');
    sizeCell.textContent = formatSize(Number(file.size_bytes));
    const dateCell = document.createElement('td');
    dateCell.textContent = new Date(file.uploaded_at).toLocaleDateString();
    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'file-actions';
    actions.append(
      button('Open', () => openFile(file)),
      button('Rename', () => openRename(file)),
      button('Delete', () => deleteFile(file))
    );
    actionsCell.append(actions);
    row.append(nameCell, typeCell, sizeCell, dateCell, actionsCell);
    tbody.append(row);
  }
}

async function loadFiles() {
  if (!databaseUserId) return;
  message('appMessage', 'Loading files…', true);
  let query = supabase.from('FILE')
    .select('file_id,file_name,file_type,size_bytes,storage_path,uploaded_at')
    .eq('user_id', databaseUserId)
    .order('uploaded_at', { ascending: false });
  const search = $('searchInput').value.trim();
  if (search) query = query.ilike('file_name', `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
  const { data, error } = await query;
  if (error) { message('appMessage', friendlyError(error)); return; }
  files = data || [];
  renderFiles();
  message('appMessage', '');
  const stats = await supabase.rpc('app_file_stats');
  if (stats.error) { message('appMessage', friendlyError(stats.error)); return; }
  $('fileCount').textContent = `${stats.data.total_files} files`;
  $('totalSize').textContent = `${formatSize(Number(stats.data.total_bytes))} used`;
}

async function openFile(file) {
  message('appMessage', 'Opening file…', true);
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(file.storage_path, 60);
  if (error) { message('appMessage', friendlyError(error)); return; }
  const link = document.createElement('a');
  link.href = data.signedUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.append(link);
  link.click();
  link.remove();
  message('appMessage', 'File opened in a new tab.', true);
}

function openRename(file) {
  renameTarget = file;
  $('newName').value = file.file_name;
  message('renameMessage', '');
  $('renameDialog').showModal();
  $('newName').focus();
}

async function deleteFile(file) {
  if (!confirm(`Delete “${file.file_name}”? This cannot be undone.`)) return;
  message('appMessage', 'Deleting file…', true);
  const removed = await supabase.storage.from(BUCKET).remove([file.storage_path]);
  if (removed.error) { message('appMessage', friendlyError(removed.error)); return; }
  const deleted = await supabase.from('FILE').delete().eq('file_id', file.file_id).eq('user_id', databaseUserId);
  if (deleted.error) { message('appMessage', `File content was removed, but its record remains: ${friendlyError(deleted.error)}`); return; }
  await loadFiles();
  message('appMessage', 'File deleted.', true);
}

async function showSession(user) {
  currentUser = user;
  $('authView').hidden = !!user;
  $('appView').hidden = !user;
  $('account').hidden = !user;
  $('email').textContent = user?.email || '';
  if (!user) { databaseUserId = null; files = []; return; }
  $('uploadButton').disabled = true;
  const account = await supabase.rpc('app_ensure_user');
  if (account.error) {
    const missingSetup = account.error.message?.includes('app_ensure_user');
    message('appMessage', missingSetup
      ? 'Database setup is missing. Run supabase-setup.sql in Supabase SQL Editor, then refresh this page.'
      : friendlyError(account.error));
    return;
  }
  databaseUserId = account.data;
  const storage = await supabase.from('STORAGE').select('storage_id').eq('storage_name', 'Supabase Demo Storage').single();
  if (storage.error) {
    message('appMessage', 'Storage setup is missing. Run supabase-setup.sql in Supabase SQL Editor, then refresh this page.');
    return;
  }
  storageId = storage.data.storage_id;
  $('uploadButton').disabled = false;
  await loadFiles();
}

async function start() {
  if (!config.url?.startsWith('https://') || !config.publishableKey || config.publishableKey.startsWith('YOUR_')) {
    $('setupNotice').hidden = false;
    $('authSubmit').disabled = true;
    $('authToggle').disabled = true;
    return;
  }
  try {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabase = createClient(config.url, config.publishableKey);
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    await showSession(data.session?.user || null);
    supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user?.id !== currentUser?.id) setTimeout(() => showSession(session?.user || null), 0);
    });
  } catch (error) {
    message('authMessage', friendlyError(error));
  }
}

$('authToggle').addEventListener('click', () => {
  registerMode = !registerMode;
  $('authSubmit').textContent = registerMode ? 'Create account' : 'Sign in';
  $('authToggle').textContent = registerMode ? 'Already have an account? Sign in' : 'Create an account';
  $('authPassword').autocomplete = registerMode ? 'new-password' : 'current-password';
  message('authMessage', '');
});

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabase) { message('authMessage', 'Connect Supabase in config.js first.'); return; }
  $('authSubmit').disabled = true;
  message('authMessage', '');
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const result = registerMode
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  $('authSubmit').disabled = false;
  if (result.error) { message('authMessage', friendlyError(result.error)); return; }
  $('authPassword').value = '';
  if (result.data.session) await showSession(result.data.session.user);
  else message('authMessage', 'Check your email to confirm your account.', true);
});

$('signOut').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) message('appMessage', friendlyError(error));
  else await showSession(null);
});

$('refreshButton').addEventListener('click', loadFiles);
$('typeFilter').addEventListener('change', renderFiles);
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadFiles, 250); });
$('uploadButton').addEventListener('click', () => {
  $('uploadForm').reset();
  $('selectedFile').textContent = 'No file selected';
  message('uploadMessage', '');
  $('uploadDialog').showModal();
});
$('fileInput').addEventListener('change', () => {
  const file = $('fileInput').files[0];
  $('selectedFile').textContent = file ? `${file.name} · ${formatSize(file.size)}` : 'No file selected';
});
document.querySelectorAll('[data-close]').forEach((element) => {
  element.addEventListener('click', () => $(element.dataset.close).close());
});

$('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('fileInput').files[0];
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { message('uploadMessage', 'This file exceeds the 50 MB demo limit.'); return; }
  $('confirmUpload').disabled = true;
  message('uploadMessage', 'Uploading…', true);
  const path = `${currentUser.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const upload = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (upload.error) { message('uploadMessage', friendlyError(upload.error)); $('confirmUpload').disabled = false; return; }
  const saved = await supabase.from('FILE').insert({
    user_id: databaseUserId,
    storage_id: storageId,
    file_name: file.name,
    file_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
    storage_path: path,
    uploaded_at: new Date().toISOString()
  });
  if (saved.error) {
    await supabase.storage.from(BUCKET).remove([path]);
    message('uploadMessage', friendlyError(saved.error));
    $('confirmUpload').disabled = false;
    return;
  }
  $('confirmUpload').disabled = false;
  $('uploadDialog').close();
  await loadFiles();
  message('appMessage', 'File uploaded and saved.', true);
});

$('renameForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('newName').value.trim();
  if (!name || !renameTarget) return;
  $('confirmRename').disabled = true;
  const result = await supabase.from('FILE').update({ file_name: name })
    .eq('file_id', renameTarget.file_id).eq('user_id', databaseUserId);
  $('confirmRename').disabled = false;
  if (result.error) { message('renameMessage', friendlyError(result.error)); return; }
  $('renameDialog').close();
  await loadFiles();
  message('appMessage', 'File renamed.', true);
});

start();
