import { Fragment } from 'react';

export const OpenInAppGuard = ({ children }: { children: React.ReactNode }) => {
  return <Fragment>{children}</Fragment>;
};
