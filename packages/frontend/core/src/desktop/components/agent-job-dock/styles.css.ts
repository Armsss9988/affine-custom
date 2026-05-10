import { cssVar } from '@toeverything/theme';
import { keyframes, style } from '@vanilla-extract/css';

export const agentJobDockWrapper = style({
  position: 'absolute',
  right: 16,
  bottom: 72, // above AIIsland (16 + 44 + 12)
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
});

export const dockBadge = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  borderRadius: 20,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  border: `0.5px solid ${cssVar('borderColor')}`,
  boxShadow: '0px 2px 8px rgba(0,0,0,0.08)',
  background: cssVar('backgroundOverlayPanelColor'),
  color: cssVar('textPrimaryColor'),
  transition: 'all 0.2s ease',
  userSelect: 'none',
  selectors: {
    '&:hover': {
      boxShadow: '0px 4px 12px rgba(0,0,0,0.12)',
      background: cssVar('hoverColor'),
    },
  },
});

const pulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.5 },
});

export const dockBadgeDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#3b82f6',
  animation: `${pulse} 1.5s ease-in-out infinite`,
});

export const dockBadgeDotSuccess = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#22c55e',
});

export const popover = style({
  width: 380,
  maxHeight: 480,
  overflowY: 'auto',
  borderRadius: 12,
  border: `0.5px solid ${cssVar('borderColor')}`,
  boxShadow: '0px 8px 24px rgba(0,0,0,0.12)',
  background: cssVar('backgroundOverlayPanelColor'),
  padding: 12,
});

export const popoverTitle = style({
  fontSize: 14,
  fontWeight: 600,
  color: cssVar('textPrimaryColor'),
  marginBottom: 8,
});

export const jobList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const jobItem = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'background 0.15s',
  selectors: {
    '&:hover': {
      background: cssVar('hoverColor'),
    },
  },
});

export const jobItemSelected = style({
  background: `${cssVar('hoverColor')}`,
  boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.3)',
});

export const jobItemHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
});

export const jobTitle = style({
  fontSize: 13,
  fontWeight: 500,
  color: cssVar('textPrimaryColor'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
});

export const jobStatus = style({
  fontSize: 11,
  fontWeight: 500,
  padding: '2px 6px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
});

export const statusRunning = style({
  background: '#dbeafe',
  color: '#2563eb',
});

export const statusSucceeded = style({
  background: '#dcfce7',
  color: '#16a34a',
});

export const statusFailed = style({
  background: '#fee2e2',
  color: '#dc2626',
});

export const statusQueued = style({
  background: '#f3f4f6',
  color: '#6b7280',
});

export const statusWaiting = style({
  background: '#fef3c7',
  color: '#d97706',
});

export const jobProgress = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
});

export const progressBarContainer = style({
  height: 4,
  background: '#e2e8f0',
  borderRadius: 2,
  overflow: 'hidden',
});

export const progressBarFill = style({
  height: '100%',
  background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
  borderRadius: 2,
  transition: 'width 0.3s ease',
});

export const progressText = style({
  fontSize: 11,
  color: cssVar('textSecondaryColor'),
});

export const jobActions = style({
  display: 'flex',
  gap: 4,
  marginTop: 4,
});

export const actionBtn = style({
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: `1px solid ${cssVar('borderColor')}`,
  background: 'transparent',
  cursor: 'pointer',
  color: cssVar('textPrimaryColor'),
  selectors: {
    '&:hover': {
      background: cssVar('hoverColor'),
    },
  },
});

export const emptyState = style({
  padding: '24px 0',
  textAlign: 'center',
  fontSize: 13,
  color: cssVar('textSecondaryColor'),
});

// Detail Panel Styles
export const detailPanel = style({
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 450,
});

export const detailPanelHeader = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  paddingBottom: 8,
  borderBottom: `0.5px solid ${cssVar('borderColor')}`,
  marginBottom: 8,
});

export const detailPanelTitle = style({
  fontSize: 14,
  fontWeight: 600,
  color: cssVar('textPrimaryColor'),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
});

export const detailPanelClose = style({
  width: 24,
  height: 24,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: cssVar('textSecondaryColor'),
  fontSize: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  selectors: {
    '&:hover': {
      background: cssVar('hoverColor'),
      color: cssVar('textPrimaryColor'),
    },
  },
});

export const detailPanelContent = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  overflowY: 'auto',
});

export const detailSection = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

export const detailSectionTitle = style({
  fontSize: 11,
  fontWeight: 600,
  color: cssVar('textSecondaryColor'),
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
});

export const detailSectionContent = style({
  fontSize: 12,
  color: cssVar('textPrimaryColor'),
});

export const promptText = style({
  display: 'block',
  fontSize: 12,
  fontFamily: 'monospace',
  color: cssVar('textPrimaryColor'),
  background: cssVar('hoverColor'),
  padding: 8,
  borderRadius: 4,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
  maxHeight: 80,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

// Steps
export const stepList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const stepItem = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '4px 0',
  fontSize: 12,
});

export const stepIcon = style({
  fontSize: 14,
  lineHeight: 1.4,
});

export const stepContent = style({
  flex: 1,
  minWidth: 0,
});

export const stepTitle = style({
  color: cssVar('textPrimaryColor'),
  fontWeight: 500,
});

export const stepDescription = style({
  color: cssVar('textSecondaryColor'),
  fontSize: 11,
  marginTop: 2,
});

export const stepError = style({
  color: '#dc2626',
  fontSize: 11,
  marginTop: 2,
  padding: '4px 6px',
  background: '#fee2e2',
  borderRadius: 4,
});

// Logs
export const logList = style({
  background: '#1e1e1e',
  borderRadius: 6,
  overflow: 'auto',
  fontSize: 11,
  fontFamily: 'monospace',
  maxHeight: 200,
});

export const logItem = style({
  display: 'flex',
  gap: 6,
  padding: '3px 8px',
  color: '#e0e0e0',
  lineHeight: 1.5,
  selectors: {
    '&:hover': {
      background: 'rgba(255,255,255,0.05)',
    },
  },
});

export const logTime = style({
  color: '#888',
  flexShrink: 0,
});

export const logLevel = style({
  flexShrink: 0,
  width: 48,
  textAlign: 'center',
  fontWeight: 600,
});

export const logMessage = style({
  color: '#e0e0e0',
  wordBreak: 'break-word',
});

// Artifacts
export const artifactList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const artifactItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  background: cssVar('hoverColor'),
  borderRadius: 6,
  fontSize: 12,
});

export const artifactIcon = style({
  fontSize: 16,
});

export const artifactContent = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flex: 1,
  gap: 8,
});

export const artifactTitle = style({
  color: cssVar('textPrimaryColor'),
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
});

export const artifactOpenBtn = style({
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 4,
  border: `1px solid #3b82f6`,
  background: 'transparent',
  color: '#3b82f6',
  cursor: 'pointer',
  fontWeight: 500,
  selectors: {
    '&:hover': {
      background: '#3b82f6',
      color: '#fff',
    },
  },
});

// Approvals
export const approvalList = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

export const approvalItem = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px',
  border: `1px solid ${cssVar('borderColor')}`,
  borderRadius: 6,
  background: '#fef9ec',
  fontSize: 12,
});

export const approvalIcon = style({
  fontSize: 16,
  lineHeight: 1.4,
});

export const approvalContent = style({
  flex: 1,
  minWidth: 0,
});

export const approvalTitle = style({
  color: cssVar('textPrimaryColor'),
  fontWeight: 500,
});

export const approvalDescription = style({
  color: cssVar('textSecondaryColor'),
  fontSize: 11,
  marginTop: 4,
});

export const approvalActions = style({
  display: 'flex',
  gap: 6,
  marginTop: 8,
});

export const approveBtn = style({
  fontSize: 11,
  padding: '4px 12px',
  borderRadius: 4,
  border: 'none',
  background: '#22c55e',
  color: '#fff',
  cursor: 'pointer',
  fontWeight: 500,
  selectors: {
    '&:hover': {
      background: '#16a34a',
    },
  },
});

export const rejectBtn = style({
  fontSize: 11,
  padding: '4px 12px',
  borderRadius: 4,
  border: 'none',
  background: '#ef4444',
  color: '#fff',
  cursor: 'pointer',
  fontWeight: 500,
  selectors: {
    '&:hover': {
      background: '#dc2626',
    },
  },
});

// Diff Preview
export const diffPreview = style({
  margin: '8px 0',
  borderRadius: 4,
  overflow: 'hidden',
});

export const diffSection = style({
  marginBottom: 4,
  selectors: {
    '&:last-child': {
      marginBottom: 0,
    },
  },
});

export const diffBeforeLabel = style({
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  padding: '2px 6px',
  background: '#fee2e2',
  color: '#991b1b',
  display: 'inline-block',
  borderRadius: 2,
});

export const diffAfterLabel = style({
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  padding: '2px 6px',
  background: '#dcfce7',
  color: '#166534',
  display: 'inline-block',
  borderRadius: 2,
});

export const diffContent = style({
  fontFamily: 'monospace',
  fontSize: 11,
  padding: '4px 6px',
  background: '#f8fafc',
  borderRadius: 2,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  marginTop: 4,
});
