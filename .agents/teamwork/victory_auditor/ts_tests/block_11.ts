export function normalizeLocatorStrategy(rawStrategy: string): LocatorStrategy {
  switch (rawStrategy.toLowerCase().trim()) {
    case 'accessibility_tree':
    case 'aria_role_name':
    case 'aria':
      return 'accessibility_tree';
    case 'semantic_attribute':
    case 'data_attribute':
    case 'data-attribute':
    case 'css_attribute_prefix':
      return 'semantic_attribute';
    case 'text_label':
    case 'label':
      return 'text_label';
    case 'witness_relation':
    case 'stable_ancestor_relative':
    case 'relative_anchor':
      return 'witness_relation';
    case 'structural_path':
    case 'css':
    case 'xpath':
    default:
      return 'structural_path';
  }
}