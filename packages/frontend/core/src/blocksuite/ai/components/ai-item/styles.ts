import { unsafeCSSVar } from '@blocksuite/affine/shared/theme';
import { darkCssVariables, lightCssVariables } from '@toeverything/theme';
import { css, unsafeCSS } from 'lit';

export const menuItemStyles = css`
  .menu-item {
    position: relative;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    box-sizing: border-box;
  }

  .menu-item:hover {
    background: ${unsafeCSSVar('--affine-hover-color')};
    cursor: pointer;
  }

  .item-icon {
    display: flex;
    color: ${unsafeCSSVar('--affine-brand-color')};

    svg {
      width: 20px;
      height: 20px;
    }
  }

  .menu-item:hover .item-icon {
    color: ${unsafeCSSVar('--affine-brand-color')};
  }

  .menu-item.discard:hover {
    background: ${unsafeCSSVar('--affine-background-error-color')};
    .item-icon {
      color: ${unsafeCSSVar('--affine-error-color')};
    }
  }

  .menu-item[data-app-theme='light']:hover {
    background: ${unsafeCSS(lightCssVariables['--affine-hover-color'])};
  }

  .menu-item.discard[data-app-theme='light']:hover {
    background: ${unsafeCSS(
      lightCssVariables['--affine-background-error-color']
    )};
  }

  .menu-item[data-app-theme='dark']:hover {
    background: ${unsafeCSS(darkCssVariables['--affine-hover-color'])};
  }

  .menu-item.discard[data-app-theme='dark']:hover {
    background: ${unsafeCSS(
      darkCssVariables['--affine-background-error-color']
    )};
  }
`;
