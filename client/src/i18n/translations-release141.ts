import type { Locale } from './core';

/** Application-owned labels introduced by Enhanced 1.4.1. */
export const release141Translations: Readonly<
  Record<string, Readonly<Record<Exclude<Locale, 'en'>, string>>>
> = {
  'The matched response is hidden by your conversation display settings.': {
    hu: 'A találatot tartalmazó választ a beszélgetések megjelenítési beállításai elrejtik.',
    de: 'Die gefundene Antwort wird durch Ihre Einstellungen zur Unterhaltungsanzeige ausgeblendet.',
    ja: '一致した応答は会話の表示設定によって非表示になっています。',
    fr: 'La réponse correspondante est masquée par vos paramètres d’affichage des conversations.',
    ru: 'Найденный ответ скрыт настройками отображения разговоров.',
  },
  'Conversation display': {
    hu: 'Beszélgetések megjelenítése',
    de: 'Unterhaltungsanzeige',
    ja: '会話の表示',
    fr: 'Affichage des conversations',
    ru: 'Отображение разговоров',
  },
  'Changes apply immediately and are saved for this browser.': {
    hu: 'A módosítások azonnal érvénybe lépnek, és ebben a böngészőben lesznek mentve.',
    de: 'Änderungen gelten sofort und werden für diesen Browser gespeichert.',
    ja: '変更はすぐに反映され、このブラウザーに保存されます。',
    fr: 'Les modifications s’appliquent immédiatement et sont enregistrées pour ce navigateur.',
    ru: 'Изменения применяются сразу и сохраняются для этого браузера.',
  },
  'JSON-only responses': {
    hu: 'Kizárólag JSON-t tartalmazó válaszok',
    de: 'Antworten nur aus JSON',
    ja: 'JSON のみの応答',
    fr: 'Réponses uniquement en JSON',
    ru: 'Ответы только в формате JSON',
  },
  'Response visibility': {
    hu: 'Válaszok láthatósága',
    de: 'Sichtbarkeit der Antworten',
    ja: '応答の表示条件',
    fr: 'Visibilité des réponses',
    ru: 'Видимость ответов',
  },
  'Show all': {
    hu: 'Mind látható',
    de: 'Alle anzeigen',
    ja: 'すべて表示',
    fr: 'Tout afficher',
    ru: 'Показывать все',
  },
  'Hide empty': {
    hu: 'Üresek elrejtése',
    de: 'Leere ausblenden',
    ja: '空の応答を非表示',
    fr: 'Masquer les vides',
    ru: 'Скрывать пустые',
  },
  'Hide all': {
    hu: 'Mind rejtett',
    de: 'Alle ausblenden',
    ja: 'すべて非表示',
    fr: 'Tout masquer',
    ru: 'Скрывать все',
  },
  'Hide empty hides recognized empty AI export metadata. Other JSON results, including zero and false, stay visible. Stored messages and exports stay unchanged.':
    {
      hu: 'Az Üresek elrejtése a felismert, üres AI-exportmetaadatokat rejti el. Minden más JSON-eredmény, köztük a nulla és a false, látható marad. A tárolt üzenetek és az exportok változatlanok maradnak.',
      de: '„Leere ausblenden“ verbirgt erkannte leere Metadaten aus KI-Exporten. Andere JSON-Ergebnisse, einschließlich der Zahl 0 und false, bleiben sichtbar. Gespeicherte Nachrichten und Exporte bleiben unverändert.',
      ja: '「空の応答を非表示」では、AI エクスポートの空のメタデータと判定されたものだけを非表示にします。0 や false を含む他の JSON 結果は表示されたままです。保存済みメッセージやエクスポートは変わりません。',
      fr: '« Masquer les vides » masque les métadonnées d’export IA reconnues comme vides. Les autres résultats JSON, y compris zéro et false, restent visibles. Les messages enregistrés et les exports restent inchangés.',
      ru: '«Скрывать пустые» скрывает распознанные пустые метаданные экспорта ИИ. Остальные результаты JSON, в том числе ноль и false, остаются видимыми. Сохранённые сообщения и экспорт не меняются.',
    },
  'Render JSON as code': {
    hu: 'JSON megjelenítése kódként',
    de: 'JSON als Code anzeigen',
    ja: 'JSON をコードとして表示',
    fr: 'Afficher le JSON comme du code',
    ru: 'Отображать JSON как код',
  },
  'Show visible JSON-only AI responses in a JSON code block. Turn off to keep their original formatting.':
    {
      hu: 'A látható, kizárólag JSON-t tartalmazó AI-válaszok JSON-kódblokkban jelennek meg. Kikapcsolva megmarad az eredeti formázásuk.',
      de: 'Sichtbare KI-Antworten, die nur aus JSON bestehen, in einem JSON-Codeblock anzeigen. Ausschalten, um ihre ursprüngliche Formatierung beizubehalten.',
      ja: '表示する JSON のみの AI 応答を JSON コードブロックにします。オフにすると元の書式を保持します。',
      fr: 'Affiche les réponses IA visibles uniquement en JSON dans un bloc de code JSON. Désactivez pour conserver leur mise en forme d’origine.',
      ru: 'Показывать видимые ответы ИИ, состоящие только из JSON, в блоке кода JSON. Выключите, чтобы сохранить исходное оформление.',
    },
  'Code blocks': {
    hu: 'Kódblokkok',
    de: 'Codeblöcke',
    ja: 'コードブロック',
    fr: 'Blocs de code',
    ru: 'Блоки кода',
  },
  'Show code download button': {
    hu: 'Kódletöltési gomb megjelenítése',
    de: 'Download-Schaltfläche für Code anzeigen',
    ja: 'コードのダウンロードボタンを表示',
    fr: 'Afficher le bouton de téléchargement du code',
    ru: 'Показывать кнопку скачивания кода',
  },
  'Download each code block as a file. Known languages use their file extension; plain text and unknown languages use .txt.':
    {
      hu: 'Minden kódblokk fájlként tölthető le. Az ismert nyelvek a saját kiterjesztésüket használják; az egyszerű szöveg és az ismeretlen nyelvek .txt kiterjesztést kapnak.',
      de: 'Jeden Codeblock als Datei herunterladen. Bekannte Sprachen verwenden ihre Dateiendung; Klartext und unbekannte Sprachen verwenden .txt.',
      ja: '各コードブロックをファイルとしてダウンロードします。既知の言語は対応する拡張子を、プレーンテキストや不明な言語は .txt を使用します。',
      fr: 'Télécharge chaque bloc de code dans un fichier. Les langages connus utilisent leur extension ; le texte brut et les langages inconnus utilisent .txt.',
      ru: 'Скачивать каждый блок кода как файл. Для известных языков используется соответствующее расширение, для обычного текста и неизвестных языков — .txt.',
    },
  'Wrap long code lines': {
    hu: 'Hosszú kódsorok tördelése',
    de: 'Lange Codezeilen umbrechen',
    ja: '長いコード行を折り返す',
    fr: 'Renvoyer les longues lignes de code à la ligne',
    ru: 'Переносить длинные строки кода',
  },
  'When off, wide code blocks scroll horizontally. When on, long lines wrap inside the code block.':
    {
      hu: 'Kikapcsolva a széles kódblokkok vízszintesen görgethetők. Bekapcsolva a hosszú sorok a kódblokkon belül tördelődnek.',
      de: 'Ausgeschaltet lassen sich breite Codeblöcke horizontal scrollen. Eingeschaltet werden lange Zeilen innerhalb des Codeblocks umgebrochen.',
      ja: 'オフの場合、幅の広いコードブロックは横にスクロールできます。オンの場合、長い行をコードブロック内で折り返します。',
      fr: 'Désactivé, les blocs de code larges défilent horizontalement. Activé, les longues lignes se replient à l’intérieur du bloc.',
      ru: 'Если выключено, широкие блоки кода прокручиваются по горизонтали. Если включено, длинные строки переносятся внутри блока.',
    },
  'Show code line numbers': {
    hu: 'Kód sorszámainak megjelenítése',
    de: 'Zeilennummern im Code anzeigen',
    ja: 'コードの行番号を表示',
    fr: 'Afficher les numéros de ligne du code',
    ru: 'Показывать номера строк кода',
  },
  'Line numbers are only a reading aid. They are never included in copied code, downloaded files or conversation exports.':
    {
      hu: 'A sorszámok csak az olvasást segítik. Soha nem kerülnek bele a másolt kódba, a letöltött fájlokba vagy a beszélgetésexportokba.',
      de: 'Zeilennummern sind nur eine Lesehilfe. Sie werden nie in kopierten Code, heruntergeladene Dateien oder Unterhaltungsexporte aufgenommen.',
      ja: '行番号は読みやすさを補う表示専用の機能です。コピーしたコード、ダウンロードしたファイル、会話のエクスポートには一切含まれません。',
      fr: 'Les numéros de ligne servent uniquement à faciliter la lecture. Ils ne sont jamais inclus dans le code copié, les fichiers téléchargés ou les exports de conversations.',
      ru: 'Номера строк служат только для удобства чтения. Они никогда не включаются в скопированный код, скачанные файлы или экспорт разговоров.',
    },
  'Start import': {
    hu: 'Importálás indítása',
    de: 'Import starten',
    ja: 'インポートを開始',
    fr: 'Lancer l’importation',
    ru: 'Начать импорт',
  },
  'Submitting…': {
    hu: 'Beküldés…',
    de: 'Wird übermittelt…',
    ja: '送信中…',
    fr: 'Envoi en cours…',
    ru: 'Отправка…',
  },
  '{count} export files found': {
    hu: '{count} exportfájl található',
    de: '{count} Exportdateien gefunden',
    ja: 'エクスポートファイルが {count} 件見つかりました',
    fr: '{count} fichiers d’export trouvés',
    ru: 'Найдено файлов экспорта: {count}',
  },
  '{count} export files found; {duplicates} will be re-indexed': {
    hu: '{count} exportfájl található; {duplicates} újra lesz indexelve',
    de: '{count} Exportdateien gefunden; {duplicates} werden neu indiziert',
    ja: 'エクスポートファイルが {count} 件見つかりました。{duplicates} 件のインデックスを再作成します',
    fr: '{count} fichiers d’export trouvés ; {duplicates} seront réindexés',
    ru: 'Найдено файлов экспорта: {count}; будет переиндексировано: {duplicates}',
  },
  'Error: {message}': {
    hu: 'Hiba: {message}',
    de: 'Fehler: {message}',
    ja: 'エラー: {message}',
    fr: 'Erreur : {message}',
    ru: 'Ошибка: {message}',
  },
};
