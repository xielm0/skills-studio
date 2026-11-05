import type { InputHTMLAttributes } from 'react';
import { SearchIcon } from './icons';
import c from '../styles/common.module.css';

interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  wrapperClassName?: string;
}

export function SearchField({ wrapperClassName = '', className = '', ...props }: SearchFieldProps) {
  return (
    <div className={`${c.searchField} ${wrapperClassName}`}>
      <SearchIcon size={16} />
      <input className={`${c.input} ${className}`} {...props} />
    </div>
  );
}
