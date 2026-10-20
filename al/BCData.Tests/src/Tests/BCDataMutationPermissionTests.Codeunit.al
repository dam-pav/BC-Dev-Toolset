using System.TestLibraries.Security.AccessControl;

codeunit 50222 "BCD Mutation Permission Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure InsertCannotElevateMissingInsert()
    var
        RunId: Guid;
    begin
        Start();
        RunId := CreateGuid();
        PermissionsMock.Set('BCD GEN R');
        asserterror Core.Execute(InsertRequest(RunId));
        Assert.ExpectedError('BCD Mutation Fixture');
        ExpectedNativeOperation('insert');
        PermissionsMock.Set('BCD GEN SETUP');
        AssertEmpty(RunId);
        PermissionsMock.Stop();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ModifyCannotElevateMissingModify()
    var
        Row: Record "BCD Mutation Fixture";
    begin
        Initialize(Row);
        PermissionsMock.Set('BCD GEN RI');
        asserterror Core.Execute(ExistingRequest('modify', Row));
        Assert.ExpectedError('BCD Mutation Fixture');
        ExpectedNativeOperation('modify');
        CheckUnchangedAndClean(Row);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeleteCannotElevateMissingDelete()
    var
        Row: Record "BCD Mutation Fixture";
    begin
        Initialize(Row);
        PermissionsMock.Set('BCD GEN RM');
        asserterror Core.Execute(ExistingRequest('delete', Row));
        Assert.ExpectedError('BCD Mutation Fixture');
        ExpectedNativeOperation('delete');
        CheckUnchangedAndClean(Row);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RenameCannotElevateMissingModify()
    var
        Row: Record "BCD Mutation Fixture";
    begin
        Initialize(Row);
        PermissionsMock.Set('BCD GEN RI');
        asserterror Core.Execute(ExistingRequest('rename', Row));
        Assert.ExpectedError('BCD Mutation Fixture');
        CheckUnchangedAndClean(Row);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ExistingTargetRequiresNativeRead()
    var
        Row: Record "BCD Mutation Fixture";
    begin
        Initialize(Row);
        PermissionsMock.Set('BCD GEN NO READ');
        asserterror Core.Execute(ExistingRequest('modify', Row));
        Assert.ExpectedError('BCD Mutation Fixture');
        ExpectedNativeOperation('read');
        CheckUnchangedAndClean(Row);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure DeniedTriggerWriteRollsBackTargetInsert()
    var
        RunId: Guid;
    begin
        Start();
        RunId := CreateGuid();
        PermissionsMock.Set('BCD GEN NO LOG I');
        asserterror Core.Execute(InsertRequest(RunId));
        Assert.ExpectedError('BCD Mutation Trigger Log');
        ExpectedNativeOperation('insert');
        PermissionsMock.Set('BCD GEN SETUP');
        AssertEmpty(RunId);
        PermissionsMock.Stop();
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure MinimalNativeGrantsPermitEachOperation()
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
        RunId: Guid;
        TargetId: Guid;
    begin
        Start();
        RunId := CreateGuid();
        PermissionsMock.Set('BCD GEN RI');
        Core.Execute(InsertRequest(RunId));
        Row.Get(RunId, 'A', 1);
        TargetId := Row.SystemId;
        PermissionsMock.Set('BCD GEN RM');
        Core.Execute(ExistingRequest('modify', Row));
        Row.GetBySystemId(TargetId);
        Row.TestField(Description, 'changed');
        Row.TestField("Modify Count", 1);
        Core.Execute(ExistingRequest('rename', Row));
        Row.GetBySystemId(TargetId);
        Row.TestField(Name, 'B');
        PermissionsMock.Set('BCD GEN RD');
        Core.Execute(ExistingRequest('delete', Row));
        Assert.IsFalse(Row.GetBySystemId(TargetId), 'Native delete must remove the row.');
        Entry.SetRange("Run ID", RunId);
        Assert.AreEqual(4, Entry.Count(), 'Each successful native trigger logged once.');
        PermissionsMock.Stop();
    end;

    local procedure Start()
    begin
        if PermissionsMock.IsStarted() then
            PermissionsMock.Stop();
        PermissionsMock.Start();
        PermissionsMock.Set('BCD GEN SETUP');
    end;

    local procedure ExpectedNativeOperation(Operation: Text)
    begin
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), Operation) > 0,
            'Native permission error must identify the denied operation.');
    end;

    local procedure Initialize(var Row: Record "BCD Mutation Fixture")
    var
        RunId: Guid;
    begin
        Start();
        RunId := CreateGuid();
        Core.Execute(InsertRequest(RunId));
        Row.Get(RunId, 'A', 1);
        Commit();
    end;

    local procedure CheckUnchangedAndClean(Row: Record "BCD Mutation Fixture")
    var
        Entry: Record "BCD Mutation Trigger Log";
    begin
        PermissionsMock.Set('BCD GEN SETUP');
        Row.GetBySystemId(Row.SystemId);
        Row.TestField(Name, 'A');
        Row.TestField(Description, '');
        Row.TestField("Modify Count", 0);
        Entry.SetRange("Run ID", Row."Run ID");
        Assert.AreEqual(1, Entry.Count(), 'Denied mutation must not persist another trigger log.');
        Row.Delete();
        Entry.DeleteAll();
        PermissionsMock.Stop();
    end;

    local procedure AssertEmpty(RunId: Guid)
    var
        Row: Record "BCD Mutation Fixture";
        Entry: Record "BCD Mutation Trigger Log";
    begin
        Row.SetRange("Run ID", RunId);
        Entry.SetRange("Run ID", RunId);
        Assert.IsTrue(Row.IsEmpty(), 'Denied insert leaves no target.');
        Assert.IsTrue(Entry.IsEmpty(), 'Denied insert leaves no trigger write.');
    end;

    local procedure InsertRequest(RunId: Guid): Text
    begin
        exit('{"operation":"insert","tableId":50221,"fields":[{"fieldId":1,"value":"' +
            Format(RunId, 0, 4) + '"},{"fieldId":2,"value":"A"},{"fieldId":3,"value":1}]}');
    end;

    local procedure ExistingRequest(Operation: Text; Row: Record "BCD Mutation Fixture"): Text
    var
        Request: Text;
    begin
        Request := '{"operation":"' + Operation + '","tableId":50221,"systemId":"' +
            Format(Row.SystemId, 0, 4) + '","expectedVersion":"' + Format(Row.SystemRowVersion, 0, 9) + '"';
        case Operation of
            'modify': Request += ',"fields":[{"fieldId":12,"value":"changed"}]';
            'rename': Request += ',"primaryKey":[{"fieldId":1,"value":"' + Format(Row."Run ID", 0, 4) +
                '"},{"fieldId":2,"value":"B"},{"fieldId":3,"value":1}]';
        end;
        exit(Request + '}');
    end;

    var
        PermissionsMock: Codeunit "Permissions Mock";
        Core: Codeunit "BCD Record Mutation";
        Assert: Codeunit "Library Assert";
}
