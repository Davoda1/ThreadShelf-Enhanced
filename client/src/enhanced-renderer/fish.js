// Dedicated Fish shell grammar for ThreadShelf Local Reader, MIT license.
// Written for this project from Fish's public syntax documentation; no Bash inheritance.
// References: https://fishshell.com/docs/current/language.html and commands.html
export default function fish(hljs) {
  const keywords = {
    $pattern: /[A-Za-z_][A-Za-z0-9_]*/,
    keyword: 'and begin break builtin case command continue else end exec for function if in not or return switch time while',
    built_in: 'abbr alias argparse bg bind block breakpoint cd commandline complete contains count dirh dirs disown echo emit eval exit false fg fish fish_add_path fish_config fish_default_key_bindings fish_git_prompt fish_hg_prompt fish_indent fish_is_root_user fish_key_reader fish_mode_prompt fish_opt fish_prompt fish_right_prompt fish_status_to_signal fish_svn_prompt fish_update_completions fish_vcs_prompt fish_vi_key_bindings funced funcsave functions history jobs math nextd open path popd prevd printf prompt_pwd psub pushd pwd random read realpath set set_color source status string suspend test trap true type ulimit umask vared wait'
  };
  const variable = { scope: 'variable', match: /\$+[A-Za-z0-9_]+(?:\[[^\]\n]*\])*/, relevance: 0 };
  const escape = { scope: 'char.escape', match: /\\[\s\S]/, relevance: 0 };
  const single = { scope: 'string', begin: /'/, end: /'/, contains: [{ scope:'char.escape', match:/\\['\\]/, relevance:0 }] };
  const double = { scope: 'string', begin: /"/, end: /"/, contains: [] };
  // Bare parentheses substitute only outside quotes. $(...) also works inside double quotes.
  const substitution = { scope: 'subst', begin: /\$?\(/, end: /\)/, keywords, contains: [] };
  const quotedSubstitution = { scope: 'subst', begin: /\$\(/, end: /\)/, keywords, contains: [] };
  const comment = hljs.inherit(hljs.COMMENT(), { match:[/(^|\s)/, /#.*$/], scope:{2:'comment'} });
  const definition = { match: [/\bfunction\b/, /[ \t]+/, /[^\s;#]+/], scope: {1:'keyword',3:'title.function'}, relevance: 3 };
  const option = { scope: 'attr', match: /(^|(?<=\s))--?[A-Za-z][A-Za-z0-9-]*/, relevance: 0 };
  const number = { scope: 'number', match: /\b\d+(?:\.\d+)?\b/, relevance: 0 };
  const operator = { scope: 'operator', match: /(?:\d+)?(?:>>?|>\?|<\??)(?:&[\d-]+|\|)?|&>>?|&&|\|\||\|&|&\||[;|&]/, relevance: 0 };
  const common = [escape, single, double, variable, comment, definition, option, number, substitution, operator];
  double.contains = [{scope:'char.escape',match:/\\(?:["\\$]|\r?\n)/,relevance:0}, variable, quotedSubstitution];
  substitution.contains = common;
  quotedSubstitution.contains = common;
  return { name:'Fish', aliases:['fishshell','fish-shell'], keywords, contains:[hljs.SHEBANG({binary:'fish',relevance:10}), ...common] };
}
