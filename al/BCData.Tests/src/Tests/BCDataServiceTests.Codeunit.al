codeunit 50202 "BCD Data Service Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure CompanionUpgradeRegistersItsService()
    var
        WebService: Record "Tenant Web Service";
        Assert: Codeunit "Library Assert";
    begin
        // [SCENARIO] Regression: an existing companion app upgrade must expose the new endpoint.
        WebService.SetRange("Service Name", 'BCDData');
        Assert.IsTrue(WebService.FindFirst(), 'Companion upgrade must register BCDData.');
        WebService.TestField("Object Type", WebService."Object Type"::Codeunit);
        WebService.TestField("Object ID", Codeunit::"BCD Data Service");
        WebService.TestField(Published, true);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure RegistrationNeverOverwritesAnotherObject()
    var
        WebService: Record "Tenant Web Service";
        Registration: Codeunit "BCD Service Registration";
        Assert: Codeunit "Library Assert";
    begin
        // [SCENARIO] An occupied name must not silently overwrite another service.
        // AutoRollback restores this dedicated target's original registration.
        WebService.SetRange("Service Name", 'BCDData');
        WebService.FindFirst();
        WebService."Object ID" := Codeunit::"BCD Transport Probe";
        WebService.Modify();
        asserterror Registration.RegisterService();
        Assert.ExpectedError('BCD_REGISTRATION_CONFLICT');
        // asserterror rolls back the transaction, including the temporary conflict.
        WebService.FindFirst();
        WebService.TestField("Object ID", Codeunit::"BCD Data Service");
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ReadinessDoesNotAdvertiseWrites()
    var
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
        Response: JsonObject;
    begin
        // [SCENARIO] The initial companion contract advertises read capabilities only.
        Response.ReadFrom(Service.Readiness('{}'));
        Assert.AreEqual(1, Value(Response, 'contractVersion').AsInteger(), 'Contract version.');
        Assert.IsFalse(Value(Response, 'mutationsEnabled').AsBoolean(), 'Unqualified mutations must remain disabled.');
        Assert.AreNotEqual('', Value(Response, 'companyId').AsText(), 'Company context is explicit.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure GenericReadReturnsIdentityVersionAndInvariantValues()
    var
        Header: Record "BCD Probe Header";
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
        Response: JsonObject;
        Item: JsonObject;
        Values: JsonObject;
        Request: JsonObject;
        Rows: JsonArray;
        Token: JsonToken;
    begin
        // [SCENARIO] E04/E10/E11 observations: generic timestamp, enum ordinal, and typed scalar encodings.
        CreateHeader(Header, CreateGuid(), 1);
        Header.Quantity := 123.456;
        Header."Probe Text" := 'Živjo 世界 😀';
        Header.Choice := Header.Choice::"BCD Probe Extra Value";
        Header."Option Choice" := Header."Option Choice"::Second;
        Header.Modify();
        Header.Get(Header."Run ID", 1);
        Request := ReadRequest(Header."Run ID", 1);
        Response.ReadFrom(Service.ReadRecords(ToText(Request)));
        Response.Get('records', Token);
        Rows := Token.AsArray();
        Rows.Get(0, Token);
        Item := Token.AsObject();
        Assert.AreEqual(LowerCase(Format(Header.SystemId, 0, 4)), Value(Item, 'systemId').AsText(), 'SystemId must match the persisted record.');
        Assert.AreEqual(Format(Header.SystemRowVersion, 0, 9), Value(Item, 'version').AsText(), 'Field 0 must match the typed rowversion.');
        Item.Get('values', Token);
        Values := Token.AsObject();
        Assert.AreEqual('123.456', Value(Values, '3').AsText(), 'Decimal is an invariant string.');
        Assert.AreEqual('Živjo 世界 😀', Value(Values, '50203').AsText(), 'Unicode text round-trips.');
        Assert.AreEqual(50242, Value(Values, '50204').AsInteger(), 'Enum uses its ordinal, never ordinal index.');
        Assert.AreEqual(2, Value(Values, '50205').AsInteger(), 'Option ordinal.');
        Assert.IsFalse(Value(Response, 'hasMore').AsBoolean(), 'Exact boundary has no extra page.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure PrimaryKeyPagesVisitEveryFixtureOnce()
    var
        Header: Record "BCD Probe Header";
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
        Request: JsonObject;
        Response: JsonObject;
        Row: JsonObject;
        Values: JsonObject;
        Rows: JsonArray;
        Token: JsonToken;
        RunId: Guid;
        LineNo: Integer;
    begin
        // [SCENARIO] E09 subset: composite primary-key paging is deterministic on static records.
        RunId := CreateGuid();
        for LineNo := 1 to 3 do
            CreateHeader(Header, RunId, LineNo);
        Request := ReadRequest(RunId, 1);
        for LineNo := 1 to 3 do begin
            Response.ReadFrom(Service.ReadRecords(ToText(Request)));
            Response.Get('records', Token);
            Rows := Token.AsArray();
            Assert.AreEqual(1, Rows.Count(), 'One row per page.');
            Rows.Get(0, Token);
            Row := Token.AsObject();
            Row.Get('values', Token);
            Values := Token.AsObject();
            Assert.AreEqual(LineNo, Value(Values, '2').AsInteger(), 'Primary-key order, without skipped or repeated rows.');
            Assert.AreEqual(LineNo < 3, Value(Response, 'hasMore').AsBoolean(), 'Boundary detection.');
            if LineNo < 3 then
                if LineNo = 1 then
                    Request.Add('position', Value(Response, 'position').AsText())
                else
                    Request.Replace('position', Value(Response, 'position').AsText());
        end;
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ReadAppliesFlowFiltersBeforeCalculation()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
        Request: JsonObject;
        Response: JsonObject;
        Filter: JsonObject;
        Row: JsonObject;
        Values: JsonObject;
        FlowFilters: JsonArray;
        Rows: JsonArray;
        Token: JsonToken;
    begin
        // [SCENARIO] E02/E05: selected FlowFields respect context but carry no related-data concurrency claim.
        CreateHeader(Header, CreateGuid(), 1);
        Entry.Init();
        Entry."Run ID" := Header."Run ID";
        Entry."Header Line No." := 1;
        Entry.Bucket := 1;
        Entry.Amount := 10;
        Entry.Insert();
        Entry."Entry No." := 0;
        Entry.Bucket := 2;
        Entry.Amount := 20;
        Entry.Insert();
        Request := ReadRequest(Header."Run ID", 1);
        Filter.Add('fieldId', 10);
        Filter.Add('expression', '1');
        FlowFilters.Add(Filter);
        Request.Add('flowFilters', FlowFilters);
        Response.ReadFrom(Service.ReadRecords(ToText(Request)));
        Response.Get('records', Token);
        Rows := Token.AsArray();
        Rows.Get(0, Token);
        Row := Token.AsObject();
        Row.Get('values', Token);
        Values := Token.AsObject();
        Assert.AreEqual('10', Value(Values, '11').AsText(), 'Only the selected bucket contributes.');
        Assert.IsFalse(Value(Response, 'flowFieldConcurrencyProtected').AsBoolean(), 'Parent rowversion cannot protect child data.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure SchemaSeesExtensionAndNoncontiguousEnumOrdinals()
    var
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
        Response: JsonObject;
        Field: JsonObject;
        Member: JsonObject;
        Fields: JsonArray;
        Members: JsonArray;
        Token: JsonToken;
        MemberToken: JsonToken;
        SawExtension: Boolean;
        SawOrdinal: Boolean;
    begin
        // [SCENARIO] E10 subset: runtime metadata includes installed extension fields and enum values.
        // Currency is inspected only for metadata; no business records are changed.
        Response.ReadFrom(Service.GetTableSchema('{"tableId":4}'));
        Response.Get('fields', Token);
        Fields := Token.AsArray();
        foreach Token in Fields do begin
            Field := Token.AsObject();
            if Value(Field, 'id').AsInteger() = 50203 then
                SawExtension := true;
            if Value(Field, 'id').AsInteger() = 50204 then begin
                Field.Get('members', MemberToken);
                Members := MemberToken.AsArray();
                foreach MemberToken in Members do begin
                    Member := MemberToken.AsObject();
                    if Value(Member, 'ordinal').AsInteger() = 50242 then
                        SawOrdinal := true;
                end;
            end;
        end;
        Assert.IsTrue(SawExtension, 'Table extension field must be discovered.');
        Assert.IsTrue(SawOrdinal, 'Enum extension ordinal 50242 must be discovered.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure RejectsDuplicateFieldsAndSpecialTables()
    var
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
    begin
        // [SCENARIO] Invalid selection and special table requests are rejected explicitly.
        asserterror Service.ReadRecords('{"tableId":50200,"fieldIds":[2,2]}');
        Assert.ExpectedError('BCD_INVALID_INPUT');
        asserterror Service.ReadRecords('{"tableId":2000000006,"fieldIds":[1]}');
        Assert.ExpectedError('BCD_UNSUPPORTED_TABLE');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure PermissionFixtureCleanupIsScopedToItsRun()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        Probe: Codeunit "BCD Permission Probe";
        Assert: Codeunit "Library Assert";
        FirstInput: Text;
        SecondRunId: Guid;
    begin
        // [SCENARIO] HTTP fixture cleanup must preserve another run's records.
        FirstInput := '{"runId":"' + Format(CreateGuid(), 0, 4) + '"}';
        SecondRunId := CreateGuid();
        Probe.Prepare(FirstInput);
        Probe.Prepare('{"runId":"' + Format(SecondRunId, 0, 4) + '"}');

        Probe.Cleanup(FirstInput);

        Header.SetRange("Run ID", SecondRunId);
        Entry.SetRange("Run ID", SecondRunId);
        Assert.AreEqual(2, Header.Count(), 'Other headers must survive cleanup.');
        Assert.AreEqual(2, Entry.Count(), 'Other entries must survive cleanup.');
        Probe.Cleanup('{"runId":"' + Format(SecondRunId, 0, 4) + '"}');
        Assert.IsTrue(Header.IsEmpty(), 'This run has no headers after cleanup.');
        Assert.IsTrue(Entry.IsEmpty(), 'This run has no entries after cleanup.');
        asserterror Probe.Cleanup('{"runId":"00000000-0000-0000-0000-000000000000"}');
        Assert.ExpectedError('BCD_E12_NONEMPTY_RUN_ID_REQUIRED');
    end;

    local procedure CreateHeader(var Header: Record "BCD Probe Header"; RunId: Guid; LineNo: Integer)
    begin
        Header.Init();
        Header."Run ID" := RunId;
        Header."Line No." := LineNo;
        Header.Insert();
    end;

    local procedure ReadRequest(RunId: Guid; Limit: Integer): JsonObject
    var
        Request: JsonObject;
        Filter: JsonObject;
        Filters: JsonArray;
        FieldIds: JsonArray;
    begin
        FieldIds.ReadFrom('[1,2,3,11,50203,50204,50205]');
        Filter.Add('fieldId', 1);
        Filter.Add('expression', Format(RunId, 0, 4));
        Filters.Add(Filter);
        Request.Add('tableId', Database::"BCD Probe Header");
        Request.Add('fieldIds', FieldIds);
        Request.Add('filters', Filters);
        Request.Add('pageSize', Limit);
        exit(Request);
    end;

    local procedure Value(Object: JsonObject; Name: Text): JsonValue
    var
        Token: JsonToken;
    begin
        Object.Get(Name, Token);
        exit(Token.AsValue());
    end;

    local procedure ToText(Object: JsonObject): Text
    var
        Output: Text;
    begin
        Object.WriteTo(Output);
        exit(Output);
    end;
}
