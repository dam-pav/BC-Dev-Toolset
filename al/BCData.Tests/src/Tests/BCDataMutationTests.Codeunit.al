codeunit 50221 "BCD Mutation Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure GenericLifecycleUsesNativeTriggers()
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Request: JsonObject;
        Response: JsonObject;
        Assignments: JsonArray;
        TargetId: Guid;
        RunId: Guid;
        Action: Text;
        ActionListText: Text;
    begin
        Request := InsertRequest(CreateGuid());
        Request.Get('fields', Token);
        Assignments := Token.AsArray();
        Add(Assignments, 4, '"3"');
        Add(Assignments, 5, '"7"');
        Request.Replace('fields', Assignments);
        Response.ReadFrom(Core.Execute(ToText(Request)));
        Evaluate(TargetId, Value(Response, 'systemId').AsText());
        Row.GetBySystemId(TargetId);
        RunId := Row."Run ID";
        Row.TestField(Name, 'A');
        Row.TestField(Trace, 'QPI');
        Row.TestField(Amount, 21);
        Row.TestField("Insert Count", 1);
        Assert.AreEqual(Format(Row.SystemRowVersion, 0, 9), Value(Response, 'version').AsText(), 'Persisted insert version.');
        Clear(Assignments);
        Add(Assignments, 5, '"5"');
        Add(Assignments, 4, '"4"');
        Request := ExistingRequest('modify', Row);
        Request.Add('fields', Assignments);
        Response.ReadFrom(Core.Execute(ToText(Request)));
        Row.GetBySystemId(TargetId);
        Row.TestField(Trace, 'QPIPQM');
        Row.TestField(Amount, 20);
        Row.TestField("Modify Count", 1);
        Assert.AreEqual('A', Row.Name, 'Omitted field remains unchanged.');
        Request := ExistingRequest('rename', Row);
        Clear(Assignments);
        Add(Assignments, 1, Quote(Format(Row."Run ID", 0, 4)));
        Add(Assignments, 2, '" b "');
        Add(Assignments, 3, '2');
        Request.Add('primaryKey', Assignments);
        Response.ReadFrom(Core.Execute(ToText(Request)));
        Row.GetBySystemId(TargetId);
        Row.TestField(Name, 'B');
        Row.TestField(Sequence, 2);
        Assert.AreEqual(LowerCase(Format(TargetId, 0, 4)), Value(Response, 'systemId').AsText(), 'Rename preserves SystemId.');
        Request := ExistingRequest('delete', Row);
        Response.ReadFrom(Core.Execute(ToText(Request)));
        Assert.IsFalse(Row.GetBySystemId(TargetId), 'Delete persists.');
        Assert.IsFalse(Response.Contains('version') or Response.Contains('values'), 'Delete returns acknowledgement only.');
        Entry.SetRange("Run ID", RunId);
        ActionListText := 'I,M,R,D';
        foreach Action in ActionListText.Split(',') do begin
            Entry.SetRange(Action, Action);
            Assert.AreEqual(1, Entry.Count(), 'Exactly one native trigger per operation.');
        end;
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure GenericScalarsReturnPersistedValues()
    var
        Row: Record "BCD Mutation Fixture";
        Request: JsonObject;
        Response: JsonObject;
        Values: JsonObject;
        Assignments: JsonArray;
        TargetId: Guid;
    begin
        Request := InsertRequest(CreateGuid());
        Request.Get('fields', Token);
        Assignments := Token.AsArray();
        Add(Assignments, 4, '"0.00000000000000000001"');
        Add(Assignments, 10, 'true');
        Add(Assignments, 11, '"9223372036854775807"');
        Add(Assignments, 12, '"Živjo 世界 😀"');
        Add(Assignments, 13, '"01234567-89ab-cdef-0123-456789abcdef"');
        Add(Assignments, 14, '{"date":"2026-12-31","closing":true}');
        Add(Assignments, 15, '"12:34:56.120"');
        Add(Assignments, 16, '"2026-10-19T12:34:56.120Z"');
        Add(Assignments, 17, '50242');
        Add(Assignments, 18, '2');
        Request.Replace('fields', Assignments);
        Response.ReadFrom(Core.Execute(ToText(Request)));
        Evaluate(TargetId, Value(Response, 'systemId').AsText());
        Row.GetBySystemId(TargetId);
        Row.TestField(Price, 2);
        Row.TestField(Flag, true);
        Row.TestField(Choice, Row.Choice::"BCD Probe Extra Value");
        Row.TestField("Option Value", Row."Option Value"::Second);
        Row.TestField("Date Value", ClosingDate(20261231D));
        Row.TestField(Description, 'Živjo 世界 😀');
        Response.Get('values', Token);
        Values := Token.AsObject();
        Assert.AreEqual('0.00000000000000000001', Value(Values, '4').AsText(), 'Stored Decimal precision.');
        Assert.AreEqual('9223372036854775807', Value(Values, '11').AsText(), 'BigInteger stays a string.');
        Assert.AreEqual('12:34:56.120', Value(Values, '15').AsText(), 'Persisted qualified Time boundary.');
        Assert.AreEqual('2026-10-19T12:34:56.120Z', Value(Values, '16').AsText(), 'Persisted qualified UTC DateTime boundary.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure InvalidAssignmentsAreRejected()
    var
        Request: JsonObject;
        Assignments: JsonArray;
    begin
        RejectDecimal('null');
        RejectDecimal('true');
        RejectDecimal('4');
        RejectDecimal('"1,5"');
        RejectDecimal('"1e2"');
        RejectDecimal('"-"');
        RejectDecimal('".2"');
        RejectDecimal('"1."');
        Request := InsertRequest(CreateGuid());
        Request.Get('fields', Token);
        Assignments := Token.AsArray();
        Add(Assignments, 2, '"B"');
        Request.Replace('fields', Assignments);
        asserterror Core.Execute(ToText(Request));
        Assert.ExpectedError('duplicate field');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure RejectSystemAndCalculatedFields()
    var
        Request: JsonObject;
        Assignments: JsonArray;
        FieldId: Integer;
        Index: Integer;
    begin
        for Index := 1 to 5 do begin
            case Index of
                1: FieldId := 0;
                2: FieldId := 2000000000;
                3: FieldId := 20;
                4: FieldId := 21;
                5: FieldId := 19;
            end;
            Request := InsertRequest(CreateGuid());
            Request.Get('fields', Token);
            Assignments := Token.AsArray();
            Add(Assignments, FieldId, '"0"');
            Request.Replace('fields', Assignments);
            asserterror Core.Execute(ToText(Request));
            Assert.ExpectedError('BCD_');
        end;
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleVersionAndKeyChangesDoNotWrite()
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Request: JsonObject;
        Assignments: JsonArray;
        RunId: Guid;
        OldVersion: Text;
        Action: Text;
        ActionListText: Text;
    begin
        RunId := CreateGuid();
        Core.Execute(ToText(InsertRequest(RunId)));
        Row.Get(RunId, 'A', 1);
        OldVersion := Format(Row.SystemRowVersion, 0, 9);
        Row.Description := 'competing change';
        Row.Modify(true);
        Commit();
        ActionListText := 'modify,delete,rename';
        foreach Action in ActionListText.Split(',') do begin
            Request := ExistingRequest(Action, Row);
            Request.Replace('expectedVersion', OldVersion);
            asserterror Core.Execute(ToText(Request));
            Assert.ExpectedError('BCD_CONCURRENCY_CONFLICT');
            Row.Get(RunId, 'A', 1);
            Row.TestField(Description, 'competing change');
            Row.TestField("Modify Count", 1);
        end;
        Request := ExistingRequest('modify', Row);
        Add(Assignments, 2, '"B"');
        Request.Add('fields', Assignments);
        asserterror Core.Execute(ToText(Request));
        Assert.ExpectedError('use rename');
        Row.Get(RunId, 'A', 1);
        Row.Delete();
        Entry.SetRange("Run ID", RunId);
        Entry.DeleteAll();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure TriggerErrorRollsBackGenericInsertAndLog()
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        RunId: Guid;
    begin
        RunId := CreateGuid();
        asserterror InsertThenFail(RunId);
        Assert.ExpectedError('BCD_GENERIC_AFTER_INSERT');
        Row.SetRange("Run ID", RunId);
        Entry.SetRange("Run ID", RunId);
        Assert.IsTrue(Row.IsEmpty(), 'Inserted row rolls back after error.');
        Assert.IsTrue(Entry.IsEmpty(), 'Native trigger write rolls back with row.');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ValidationCannotRedirectModify()
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        Request: JsonObject;
        Assignments: JsonArray;
        RunId: Guid;
        OriginalId: Guid;
    begin
        RunId := CreateGuid();
        Core.Execute(ToText(InsertRequest(RunId)));
        Row.Get(RunId, 'A', 1);
        OriginalId := Row.SystemId;
        Commit();
        Request := ExistingRequest('modify', Row);
        Add(Assignments, 12, '"BCD_MOVE_KEY"');
        Request.Add('fields', Assignments);
        asserterror Core.Execute(ToText(Request));
        Assert.ExpectedError('validation changed the primary key; use rename');
        Row.GetBySystemId(OriginalId);
        Row.TestField(Name, 'A');
        Row.TestField(Description, '');
        Row.TestField("Modify Count", 0);
        Row.Delete();
        Entry.SetRange("Run ID", RunId);
        Entry.DeleteAll();
    end;

    local procedure InsertThenFail(RunId: Guid)
    begin
        Core.Execute(ToText(InsertRequest(RunId)));
        Error('BCD_GENERIC_AFTER_INSERT');
    end;

    local procedure RejectDecimal(Input: Text)
    var
        Request: JsonObject;
        Assignments: JsonArray;
    begin
        Request := InsertRequest(CreateGuid());
        Request.Get('fields', Token);
        Assignments := Token.AsArray();
        Add(Assignments, 4, Input);
        Request.Replace('fields', Assignments);
        asserterror Core.Execute(ToText(Request));
        Assert.ExpectedError('BCD_INVALID_INPUT');
    end;

    local procedure InsertRequest(RunId: Guid): JsonObject
    var
        Request: JsonObject;
        Assignments: JsonArray;
    begin
        Request.Add('operation', 'insert');
        Request.Add('tableId', Database::"BCD Mutation Fixture");
        Add(Assignments, 1, Quote(Format(RunId, 0, 4)));
        Add(Assignments, 2, '" a "');
        Add(Assignments, 3, '1');
        Request.Add('fields', Assignments);
        exit(Request);
    end;

    local procedure ExistingRequest(Operation: Text; Row: Record "BCD Mutation Fixture"): JsonObject
    var
        Request: JsonObject;
    begin
        Request.Add('operation', Operation);
        Request.Add('tableId', Database::"BCD Mutation Fixture");
        Request.Add('systemId', Format(Row.SystemId, 0, 4));
        Request.Add('expectedVersion', Format(Row.SystemRowVersion, 0, 9));
        exit(Request);
    end;

    local procedure Add(var Assignments: JsonArray; FieldId: Integer; Input: Text)
    var
        Assignment: JsonObject;
        InputToken: JsonToken;
    begin
        InputToken.ReadFrom(Input);
        Assignment.Add('fieldId', FieldId);
        Assignment.Add('value', InputToken);
        Assignments.Add(Assignment);
    end;

    local procedure Value(ObjectValue: JsonObject; Name: Text): JsonValue
    var
        Result: JsonToken;
    begin
        ObjectValue.Get(Name, Result);
        exit(Result.AsValue());
    end;

    local procedure Quote(ValueText: Text): Text
    var
        JsonString: JsonValue;
        Output: Text;
    begin
        JsonString.SetValue(ValueText);
        JsonString.WriteTo(Output);
        exit(Output);
    end;

    local procedure ToText(Request: JsonObject): Text
    var
        Output: Text;
    begin
        Request.WriteTo(Output);
        exit(Output);
    end;

    var
        Core: Codeunit "BCD Record Mutation";
        Assert: Codeunit "Library Assert";
        Token: JsonToken;
}
