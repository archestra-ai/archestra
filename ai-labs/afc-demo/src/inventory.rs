//! Build a checker [`Inventory`] from a config directory + fixtures. Representative labels stand in
//! for the concrete labels a read produces / a sink requires, which is all the class-level leak-path
//! analysis needs.

use std::collections::BTreeSet;
use std::path::Path;

use afc_core::checker::{ChainEntry, DeclassEntry, Inventory, ToolEntry};
use afc_core::label::{DimValue, Integrity, Label, Readers, Subject};
use afc_core::rule::Effect;
use afc_surface::{ResultTier, SinkDim, SinkReaders, ToolSpec, compile_dir};

use crate::fixtures;

pub fn build_inventory(config_dir: &Path) -> Result<Inventory, String> {
    let policy = compile_dir(config_dir).map_err(|e| e.to_string())?;

    let mut tools: Vec<ToolEntry> = policy
        .tools
        .iter()
        .map(|t| ToolEntry {
            id: t.id.clone(),
            effects: t.effects.clone(),
            fields: t.fields.clone(),
            labeled: t.labeled,
            produces: representative_produces(t),
            sink: representative_sink(t),
        })
        .collect();

    // legacy.dump exists in the world but has no annotation — an Unlabeled/Unknown tool.
    tools.push(ToolEntry {
        id: "legacy.dump".to_string(),
        effects: BTreeSet::from([Effect::Read]),
        fields: Default::default(),
        labeled: false,
        produces: None,
        sink: None,
    });

    let declassifiers = policy
        .declassifiers
        .iter()
        .map(|d| DeclassEntry {
            id: d.id.clone(),
            relabel: d.relabel.clone(),
            robust: d.robust,
        })
        .collect();

    let chains = policy
        .chains
        .iter()
        .map(|c| ChainEntry {
            id: c.id.clone(),
            effect: c.effect,
        })
        .collect();

    let assumptions = policy
        .on_unknown
        .assumptions
        .iter()
        .map(|(tool, _)| tool.clone())
        .collect();

    Ok(Inventory {
        tools,
        rules: policy.rules,
        dims: policy.dims,
        declassifiers,
        chains,
        assumptions,
        dir: fixtures::directory(),
        principal: fixtures::principal(),
    })
}

fn representative_produces(t: &ToolSpec) -> Option<Label> {
    match &t.result {
        ResultTier::Static(label) => Some(label.clone()),
        // A resolver-labeled read is, representatively, owner-only clean content.
        ResultTier::Resolver => Some(Label {
            readers: Readers::Known([Subject::User("X".into())].into()),
            integrity: Integrity::Clean,
            dims: Default::default(),
            provenance: vec![],
            provenance_truncated: false,
        }),
        ResultTier::Unknown => None,
    }
}

fn representative_sink(t: &ToolSpec) -> Option<Label> {
    let sink = t.sink.as_ref()?;
    let readers = match &sink.readers {
        SinkReaders::Public => Readers::Known([Subject::Any].into()),
        SinkReaders::Principal => Readers::Known([Subject::User("X".into())].into()),
        // A written doc is representatively team-shared; a recipient is representatively an outsider.
        SinkReaders::FromArgAcl(_) => Readers::Known(
            [Subject::User("X".into()), Subject::Team("eng".into())].into(),
        ),
        SinkReaders::FromArgRecipient(_) => Readers::Known([Subject::User("external".into())].into()),
    };
    let mut dims = std::collections::BTreeMap::new();
    for (id, sd) in &sink.dims {
        let v = match sd {
            SinkDim::Static(v) => v.clone(),
            SinkDim::FromArg(_) => DimValue::val("EU"),
        };
        dims.insert(id.clone(), v);
    }
    Some(Label {
        readers,
        integrity: Integrity::Clean,
        dims,
        provenance: vec![],
        provenance_truncated: false,
    })
}
