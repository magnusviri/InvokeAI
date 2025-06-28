import { IconButton } from '@invoke-ai/ui-library';
import { useModelUploadButton } from 'common/hooks/useModelUploadButton';
import { t } from 'i18next';
import { memo } from 'react';
import { PiUploadBold } from 'react-icons/pi';

const UPLOAD_OPTIONS: Parameters<typeof useModelUploadButton>[0] = { allowMultiple: true };

export const ModelUploadButton = memo(() => {
  const uploadApi = useModelUploadButton(UPLOAD_OPTIONS);
  return (
    <>
      <IconButton
        size="sm"
        alignSelf="stretch"
        variant="link"
        aria-label={t('accessibility.uploadImages')}
        tooltip={t('accessibility.uploadImages')}
        icon={<PiUploadBold />}
        {...uploadApi.getUploadButtonProps()}
      />
      <input {...uploadApi.getUploadInputProps()} />
    </>
  );
});
ModelUploadButton.displayName = 'ModelUploadButton';
