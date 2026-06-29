export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-leading-blank': [1, 'always'],
    'body-max-line-length': [1, 'always', 100],
    'footer-leading-blank': [1, 'always'],
    'footer-max-line-length': [1, 'always', 100],
    'header-max-length': [1, 'always', 100],
    'subject-case': [0, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'type-case': [2, 'always', ['lower-case', 'camel-case']],
    'type-empty': [2, 'never'],
    'type-enum': [2, 'always', ['feat', 'fix', 'perf', 'docs', 'deps', 'ci', 'refactor', 'revert', 'test', 'chore']],
  },
};
