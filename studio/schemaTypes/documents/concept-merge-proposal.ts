import {SplitVerticalIcon} from '@sanity/icons'
import {defineArrayMember, defineField, defineType} from 'sanity'

/**
 * A proposed merge of semantically equivalent concepts that lexical matching
 * missed (`prompts/pr-3-equivalence-merges.md`). Drafted by `npm run
 * generate:concepts -- consolidate` with status "proposed"; it merges nothing.
 * An editor confirms or rejects it here — the status on the draft is the
 * decision, so it has no publish action. The next `extract` run applies an
 * accepted proposal to unpublished drafts only, by stable candidate ids;
 * published concepts are merged by hand (tombstone). Rejecting never removes a
 * concept: members of a proposal that was already applied are restored by the
 * next `extract` run. A rejected proposal is kept and suppresses only the same
 * members at the same prompt and config versions.
 */
export const conceptMergeProposal = defineType({
  name: 'conceptMergeProposal',
  title: 'Concept merge proposal',
  type: 'document',
  icon: SplitVerticalIcon,
  description: 'Merge proposal, created only by `npm run generate:concepts -- consolidate`.',
  fields: [
    defineField({
      name: 'status',
      type: 'string',
      options: {
        list: [
          {title: 'Proposed', value: 'proposed'},
          {title: 'Accepted', value: 'accepted'},
          {title: 'Rejected', value: 'rejected'},
        ],
        layout: 'radio',
        direction: 'horizontal',
      },
      initialValue: 'proposed',
      description:
        'Accept only when the members are the same concept under different names. Accepting lets the next extract run fold the members into the canonical draft (their names become aliases) and delete the other unedited drafts. Rejecting keeps every concept; an applied merge is undone by the next extract run. Published concepts are never merged automatically.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'canonical',
      type: 'object',
      readOnly: true,
      description: 'The member that survives.',
      fields: [
        defineField({name: 'conceptId', type: 'string'}),
        defineField({name: 'candidateIds', type: 'array', of: [defineArrayMember({type: 'string'})]}),
      ],
    }),
    defineField({
      name: 'members',
      type: 'array',
      readOnly: true,
      of: [
        defineArrayMember({
          name: 'conceptMergeMember',
          type: 'object',
          fields: [
            defineField({name: 'conceptId', type: 'string'}),
            defineField({name: 'name', type: 'string'}),
            defineField({name: 'candidateIds', type: 'array', of: [defineArrayMember({type: 'string'})]}),
            defineField({name: 'concept', type: 'reference', to: [{type: 'concept'}], weak: true}),
          ],
          preview: {select: {title: 'name', subtitle: 'conceptId'}},
        }),
      ],
    }),
    defineField({name: 'rationale', type: 'text', rows: 3, readOnly: true}),
    defineField({
      name: 'evidence',
      title: 'Evidence chunks',
      type: 'array',
      readOnly: true,
      of: [defineArrayMember({type: 'conceptSourceRef'})],
    }),
    defineField({name: 'note', title: 'Reviewer note', type: 'text', rows: 2}),
    defineField({
      name: 'generation',
      type: 'object',
      readOnly: true,
      options: {collapsible: true, collapsed: true},
      fields: [
        defineField({name: 'course', type: 'reference', to: [{type: 'course'}]}),
        defineField({name: 'key', type: 'string'}),
        defineField({name: 'suppressionKey', type: 'string'}),
        defineField({name: 'model', type: 'string'}),
        defineField({name: 'promptVersion', type: 'string'}),
        defineField({name: 'configVersion', type: 'string'}),
        defineField({name: 'contentHash', type: 'string'}),
        defineField({name: 'generatedAt', type: 'datetime'}),
      ],
    }),
  ],
  preview: {
    select: {members: 'members', status: 'status'},
    prepare({members, status}) {
      const names = ((members as Array<{name?: string}> | undefined) ?? []).map((member) => member.name ?? '?')
      return {title: names.join(' + ') || 'Merge proposal', subtitle: status}
    },
  },
})
