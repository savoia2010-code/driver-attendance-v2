// このファイルをコピーして config.js にリネームし、値を設定してください
// config.js は GitHub Pages で配信する必要があるためリポジトリに含まれる。
// ここに書いた値は公開される前提で扱うこと（秘密は入れない）
const CONFIG = {
  // バックエンドのURL
  //   開発: 'http://localhost:3000/mock-gas'（モックサーバー）
  //   本番: GASのデプロイURL（https://script.google.com/macros/s/.../exec）
  GAS_URL: 'ここにURLを入れる',

  // APIアクセストークン（GASのスクリプトプロパティ ACCESS_TOKEN と同じ値）
  // モックサーバー利用時は空文字でよい
  APP_TOKEN: '',
};
