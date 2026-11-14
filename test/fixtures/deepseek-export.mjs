// A small synthetic DeepSeek format-3 export for the official importer.
// The unselected reply must not become a Message Edit version.
export function deepseekExportEntries(image) {
  const time = '2026-11-01T00:00:00Z';
  const message = (id, parent_id, role, fragments, status = 'FINISHED') => ({
    id, parent_id, role, fragments, status, inserted_at: time,
  });
  const files = [
    { id: 'qa-image', file_name: 'imported.png', file_size: image.length, is_image: true,
      export_path: 'chat_sessions/qa-import_files/qa-image_imported.png' },
    { id: 'qa-missing', file_name: 'unavailable.txt', file_size: 12, is_image: false, export_path: null },
  ];
  const conversation = {
    id: 'qa-import', title: 'Imported QA: tools, image, file and error', inserted_at: time, current_message_id: 4,
    messages: [
      message(1, null, 'USER', [{ type: 'REQUEST', content: 'Imported first prompt' }, { type: 'FILE', files }]),
      message(2, 1, 'ASSISTANT', [
        { type: 'THINK', content: 'Imported reasoning.', elapsed_secs: 1 },
        { type: 'TOOL_SEARCH', queries: ['qa example'], results: [{ url: 'https://example.com', title: 'QA example', snippet: 'Imported search result.' }] },
        { type: 'RESPONSE', content: 'Imported answer with a web result.' },
      ]),
      message(3, 2, 'USER', [{ type: 'REQUEST', content: 'Imported error prompt' }, { type: 'FILE', files }]),
      message(4, 3, 'ASSISTANT', [], 'FAILED'),
      message(5, 1, 'ASSISTANT', [{ type: 'RESPONSE', content: 'Unselected original DeepSeek branch' }]),
    ],
  };
  const json = value => new TextEncoder().encode(JSON.stringify(value));
  return {
    'manifest.json': json({ export_format_version: 3 }),
    'chat_session_index.json': json([{ id: conversation.id, inserted_at: time, updated_at: time }]),
    'chat_sessions/qa-import.json': json(conversation),
    [files[0].export_path]: image,
  };
}
