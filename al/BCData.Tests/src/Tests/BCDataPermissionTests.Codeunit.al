using System.TestLibraries.Security.AccessControl;

codeunit 50203 "BCD Data Permission Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure HeaderReadNeedsNoRelatedTableAccess()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        Response: JsonObject;
    begin
        // [SCENARIO] Selecting a stored field must not calculate unselected FlowFields.
        Initialize(Header);
        PermissionsMock.Set('BCD TEST HEADER R');
        Assert.IsTrue(Header.ReadPermission(), 'Header read must be granted.');
        Assert.IsFalse(Header.WritePermission(), 'Header writes must not be granted.');
        Assert.IsFalse(Entry.ReadPermission(), 'Related data must be inaccessible.');

        Response.ReadFrom(Service.ReadRecords(Request(Header."Run ID", '[2]')));

        Assert.AreEqual('1', FirstValue(Response, '2'), 'Selected stored value is readable.');
        PermissionsMock.Stop();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure ServiceDoesNotElevateHeaderRead()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Executing the service cannot grant missing table-data read rights.
        Initialize(Header);
        PermissionsMock.Set('BCD TEST NONE');
        Assert.IsFalse(Header.ReadPermission(), 'A denied context is required for this test.');

        asserterror Service.ReadRecords(Request(Header."Run ID", '[2]'));

        Assert.ExpectedError('BCD Probe Header');
        Assert.ExpectedError('BCD_PERMISSION_DENIED:');
        PermissionsMock.Stop();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure FlowFieldCannotReadDeniedRelatedTable()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
    begin
        // [SCENARIO] Parent read rights cannot grant access to a FlowField's source.
        Initialize(Header);
        PermissionsMock.Set('BCD TEST HEADER R');
        Assert.IsTrue(Header.ReadPermission(), 'Parent read is permitted.');
        Assert.IsFalse(Entry.ReadPermission(), 'Related read must be denied.');

        asserterror Service.ReadRecords(Request(Header."Run ID", '[11]'));

        Assert.ExpectedError('BCD Probe Sum Entry');
        Assert.ExpectedError('BCD_PERMISSION_DENIED:');
        PermissionsMock.Stop();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure FlowFieldReadRequiresNoWriteRights()
    var
        Header: Record "BCD Probe Header";
        Entry: Record "BCD Probe Sum Entry";
        Response: JsonObject;
    begin
        // [SCENARIO] Read-only access to parent and child suffices for a calculated read.
        Initialize(Header);
        PermissionsMock.Set('BCD TEST RELATED R');
        Assert.IsTrue(Header.ReadPermission(), 'Parent read is permitted.');
        Assert.IsTrue(Entry.ReadPermission(), 'Related read is permitted.');
        Assert.IsFalse(Header.WritePermission(), 'Parent writes are denied.');
        Assert.IsFalse(Entry.WritePermission(), 'Related writes are denied.');

        Response.ReadFrom(Service.ReadRecords(Request(Header."Run ID", '[11]')));

        Assert.AreEqual('42', FirstValue(Response, '11'), 'FlowField is calculated without write rights.');
        PermissionsMock.Stop();
    end;

    local procedure Initialize(var Header: Record "BCD Probe Header")
    var
        Entry: Record "BCD Probe Sum Entry";
    begin
        // These mocks affect this test session only; no user or access-control rows change.
        if PermissionsMock.IsStarted() then
            PermissionsMock.Stop();
        PermissionsMock.Start();
        PermissionsMock.Set('BCD TEST SETUP');
        Header.Init();
        Header."Run ID" := CreateGuid();
        Header."Line No." := 1;
        Header.Insert();
        Entry.Init();
        Entry."Run ID" := Header."Run ID";
        Entry."Header Line No." := 1;
        Entry.Amount := 42;
        Entry.Insert();
    end;

    local procedure Request(RunId: Guid; Fields: Text): Text
    var
        Input: JsonObject;
        Filter: JsonObject;
        Filters: JsonArray;
        FieldIds: JsonArray;
        Output: Text;
    begin
        FieldIds.ReadFrom(Fields);
        Filter.Add('fieldId', 1);
        Filter.Add('expression', Format(RunId, 0, 4));
        Filters.Add(Filter);
        Input.Add('tableId', Database::"BCD Probe Header");
        Input.Add('fieldIds', FieldIds);
        Input.Add('filters', Filters);
        Input.Add('pageSize', 1);
        Input.WriteTo(Output);
        exit(Output);
    end;

    local procedure FirstValue(Response: JsonObject; FieldId: Text): Text
    var
        Token: JsonToken;
        Rows: JsonArray;
        Row: JsonObject;
        Values: JsonObject;
    begin
        Response.Get('records', Token);
        Rows := Token.AsArray();
        Assert.AreEqual(1, Rows.Count(), 'Only this test fixture is read.');
        Rows.Get(0, Token);
        Row := Token.AsObject();
        Row.Get('values', Token);
        Values := Token.AsObject();
        Values.Get(FieldId, Token);
        exit(Token.AsValue().AsText());
    end;

    var
        PermissionsMock: Codeunit "Permissions Mock";
        Service: Codeunit "BCD Data Service";
        Assert: Codeunit "Library Assert";
}
