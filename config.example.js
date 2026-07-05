// このファイルをコピーして config.js にリネームし、値を設定してください
// config.js は .gitignore に含まれており、リポジトリには含まれません
const CONFIG = {
  // バックエンドのURL
  //   開発: 'http://localhost:3000/mock-gas'（モックサーバー）
  //   本番: GASのデプロイURL（https://script.google.com/macros/s/.../exec）
  GAS_URL: 'ここにURLを入れる',

  // APIアクセストークン（GASのスクリプトプロパティ ACCESS_TOKEN と同じ値）
  // モックサーバー利用時は空文字でよい
  APP_TOKEN: '',
};
