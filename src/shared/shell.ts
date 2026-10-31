/** Quote a literal Unix shell argument, including embedded quotes and substitutions. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
