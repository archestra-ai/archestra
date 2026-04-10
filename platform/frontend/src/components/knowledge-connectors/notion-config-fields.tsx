import React from 'react';
import { UseFormReturn } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { KnowledgeConnectorType, NotionConfig } from '@/platform/shared/knowledge-base';

interface NotionConfigFieldsProps {
  form: UseFormReturn<NotionConfig & { type: KnowledgeConnectorType }, any, undefined>;
  isEdit?: boolean;
}

export function NotionConfigFields({ form, isEdit }: NotionConfigFieldsProps) {
  return (
    <>
      <FormField
        control={form.control}
        name="integrationToken"
        rules={{ required: 'Notion Integration Token is required.' }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Integration Token</FormLabel>
            <FormControl>
              <Input
                type="password"
                placeholder="secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                {...field}
                autoComplete="off"
              />
            </FormControl>
            <FormDescription>
              Your Notion integration token (starts with `secret_`). Make sure the integration has access to the
              pages/databases you want to sync.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="databaseIds"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Database IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="comma-separated list of database IDs"
                {...field}
                value={field.value ? field.value.join(', ') : ''}
                onChange={(e) => field.onChange(e.target.value.split(',').map((id) => id.trim()).filter(Boolean))}
              />
            </FormControl>
            <FormDescription>
              Optional. Sync only specific Notion databases by providing a comma-separated list of IDs.
              If left empty, all accessible pages will be synced via search.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="pageIds"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Page IDs (optional)</FormLabel>
            <FormControl>
              <Input
                placeholder="comma-separated list of page IDs"
                {...field}
                value={field.value ? field.value.join(', ') : ''}
                onChange={(e) => field.onChange(e.target.value.split(',').map((id) => id.trim()).filter(Boolean))}
              />
            </FormControl>
            <FormDescription>
              Optional. Sync only specific Notion pages by providing a comma-separated list of IDs.
              If left empty, all accessible pages will be synced via search.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
