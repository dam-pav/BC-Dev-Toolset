codeunit 50200 "BCD RecordRef Tests"
// [FEATURE] [BC Data] Generic table compatibility
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure CompositeRenamePreservesIdentity()
    var
        Header: Record "BCD Probe Header";
        RenameLog: Record "BCD Probe Rename Log";
        HeaderRef: RecordRef;
        OriginalId: Guid;
    begin
        // [SCENARIO] E03: Generic rename preserves SystemId and executes OnRename.
        // [GIVEN] A fresh physical record with a GUID/integer composite key.
        CreateHeader(Header);
        OriginalId := Header.SystemId;
        HeaderRef.GetTable(Header);

        // [WHEN] Its integer key component changes through RecordRef.
        HeaderRef.Rename(Header."Run ID", 2);
        HeaderRef.Close();

        // [THEN] The persisted key changes, identity is preserved, and the trigger records the event.
        Header.GetBySystemId(OriginalId);
        Header.TestField("Line No.", 2);
        RenameLog.SetRange("Run ID", Header."Run ID");
        Check(RenameLog.Count() = 1, 'E03: Exactly one OnRename event is required.');
        RenameLog.FindFirst();
        RenameLog.TestField("Old Line No.", 1);
        RenameLog.TestField("New Line No.", 2);
        Check(not Header.Get(Header."Run ID", 1), 'E03: The old primary key must no longer exist.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure FieldValidationPreservesOrder()
    var
        Header: Record "BCD Probe Header";
        HeaderRef: RecordRef;
        ValueField: FieldRef;
    begin
        // [SCENARIO] E13: Ordered FieldRef validation persists calculated changes and runs OnModify.
        // [GIVEN] An initialized record with no prior validation trace.
        CreateHeader(Header);
        HeaderRef.GetTable(Header);

        // [WHEN] Quantity and price are validated in that order and saved.
        ValueField := HeaderRef.Field(Header.FieldNo(Quantity));
        ValueField.Validate(3);
        ValueField := HeaderRef.Field(Header.FieldNo("Unit Price"));
        ValueField.Validate(7);
        HeaderRef.Modify(true);
        HeaderRef.Close();

        // [THEN] Rereading verifies both order and persisted trigger effects.
        Header.Get(Header."Run ID", Header."Line No.");
        Header.TestField("Validation Trace", 'QP');
        Header.TestField(Amount, 21);
        Header.TestField("Modify Count", 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure FlowFilterScopesGenericCalculation()
    var
        Header: Record "BCD Probe Header";
        HeaderRef: RecordRef;
        FilterField: FieldRef;
        TotalField: FieldRef;
        ActualTotal: Decimal;
    begin
        // [SCENARIO] E02: A FlowFilter limits a FlowField calculated through FieldRef.
        // [GIVEN] Two buckets belonging to the same header.
        CreateHeader(Header);
        CreateEntry(Header, 1, 10);
        CreateEntry(Header, 2, 20);
        HeaderRef.GetTable(Header);
        FilterField := HeaderRef.Field(Header.FieldNo("Bucket Filter"));
        FilterField.SetRange(1);
        TotalField := HeaderRef.Field(Header.FieldNo("Entry Total"));

        // [WHEN] Only the selected FlowField is calculated.
        TotalField.CalcField();

        // [THEN] The other bucket is excluded.
        ActualTotal := TotalField.Value;
        Check(ActualTotal = 10, 'E02: FlowFilter must exclude the second bucket.');
        HeaderRef.Close();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure TypedSumFlowFieldValidationDoesNotWriteThrough()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
    begin
        // [SCENARIO] E02: Typed Validate changes the calculated value but does not write through to source rows.
        // [GIVEN] Exactly one contributing child record, selected by a FlowFilter.
        CreateHeader(Header);
        CreateEntry(Header, 1, 10);
        Header.SetRange("Bucket Filter", 1);
        Header.CalcFields("Entry Total");

        // [WHEN] The typed path validates and saves a new total.
        Header.Validate("Entry Total", 25);
        Header.Modify(true);

        // [THEN] The underlying physical row remains unchanged; Modify does not persist a FlowField value.
        Entry.SetRange("Run ID", Header."Run ID");
        Entry.SetRange("Header Line No.", Header."Line No.");
        Entry.SetRange(Bucket, 1);
        Entry.FindFirst();
        Entry.TestField(Amount, 10);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure GenericSumFlowFieldValidationDoesNotWriteThrough()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        HeaderRef: RecordRef;
        FilterField: FieldRef;
        TotalField: FieldRef;
    begin
        // [SCENARIO] E02: FieldRef Validate on a Sum FlowField does not write through to source rows.
        // [GIVEN] Exactly one contributing child record, selected by a FlowFilter.
        CreateHeader(Header);
        CreateEntry(Header, 1, 10);
        HeaderRef.GetTable(Header);
        FilterField := HeaderRef.Field(Header.FieldNo("Bucket Filter"));
        FilterField.SetRange(1);
        TotalField := HeaderRef.Field(Header.FieldNo("Entry Total"));
        TotalField.CalcField();

        // [WHEN] The generic path validates and saves a new total.
        TotalField.Validate(25);
        HeaderRef.Modify(true);
        HeaderRef.Close();

        // [THEN] The underlying physical row remains unchanged after RecordRef.Modify.
        Entry.SetRange("Run ID", Header."Run ID");
        Entry.SetRange("Header Line No.", Header."Line No.");
        Entry.SetRange(Bucket, 1);
        Entry.FindFirst();
        Entry.TestField(Amount, 10);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ChildWriteLeavesParentVersionUnchanged()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        OriginalVersion: BigInteger;
    begin
        // [SCENARIO] E05 hypothesis: A parent rowversion does not version its FlowField source rows.
        // [GIVEN] A reread parent with a known child total and captured rowversion.
        CreateHeader(Header);
        CreateEntry(Header, 1, 10);
        Header.Get(Header."Run ID", Header."Line No.");
        OriginalVersion := Header.SystemRowVersion;
        Entry.SetRange("Run ID", Header."Run ID");
        Entry.SetRange("Header Line No.", Header."Line No.");
        Entry.SetRange(Bucket, 1);
        Entry.FindFirst();

        // [WHEN] Only the child amount changes.
        Entry.Validate(Amount, 25);
        Entry.Modify(true);

        // [THEN] The total changes while the physical parent rowversion does not.
        Header.Get(Header."Run ID", Header."Line No.");
        Header.CalcFields("Entry Total");
        Header.TestField("Entry Total", 25);
        Check(Header.SystemRowVersion = OriginalVersion, 'E05: Observe whether the parent token changes after a child write.');
    end;

    local procedure CreateHeader(var Header: Record "BCD Probe Header")
    begin
        Header.Init();
        Header."Run ID" := CreateGuid();
        Header."Line No." := 1;
        Header.Insert(true);
        Header.Get(Header."Run ID", Header."Line No.");
    end;

    local procedure CreateEntry(Header: Record "BCD Probe Header"; Bucket: Integer; Amount: Decimal)
    var
        Entry: Record "BCD Probe Sum Entry";
    begin
        Entry.Init();
        Entry."Run ID" := Header."Run ID";
        Entry."Header Line No." := Header."Line No.";
        Entry.Bucket := Bucket;
        Entry.Amount := Amount;
        Entry.Insert(true);
    end;

    local procedure Check(Condition: Boolean; Failure: Text)
    var
        Assert: Codeunit "Library Assert";
    begin
        Assert.IsTrue(Condition, Failure);
    end;
}
